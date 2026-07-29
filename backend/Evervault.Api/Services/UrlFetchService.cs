using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.RegularExpressions;
using ReverseMarkdown;
using SmartReader;

namespace Evervault.Api.Services;

/// <summary>Why a URL fetch failed, so the caller can tell the model something useful.</summary>
public enum UrlFetchFailure
{
    /// <summary>Not a URL we will ever fetch — bad syntax, non-http scheme, or an address that points back
    /// inside our own network.</summary>
    Blocked,
    /// <summary>The site answered with an error status (404, 403, a bot wall, 5xx…).</summary>
    HttpError,
    /// <summary>Reachable, but not something we can turn into text (a PDF, an image, a video).</summary>
    Unsupported,
    /// <summary>DNS/TLS/connection failure, or the fetch ran out of time.</summary>
    Unreachable,
}

public class UrlFetchException : Exception
{
    public UrlFetchFailure Kind { get; }
    public UrlFetchException(UrlFetchFailure kind, string message) : base(message) => Kind = kind;
}

/// <summary>The readable content of one page.</summary>
public record UrlFetchResult(
    string Url,
    string? Title,
    string? Author,
    string? SiteName,
    DateTimeOffset? Published,
    string Content,
    bool Truncated);

public interface IUrlFetchService
{
    /// <summary>Fetch a URL and return its main content as markdown. Throws
    /// <see cref="UrlFetchException"/> for every expected failure.</summary>
    Task<UrlFetchResult> FetchAsync(string url, CancellationToken ct);
}

/// <summary>
/// Fetches a web page server-side and reduces it to the readable article text, so the assistant can open a
/// link the user pasted (or one a search turned up) instead of guessing at its contents.
///
/// <b>No JavaScript.</b> The page is parsed as delivered — no headless browser. That covers static and
/// server-rendered pages, which is the large majority of article-shaped content, and costs nothing in image
/// size or startup risk. A client-rendered SPA will come back thin or empty, which is reported honestly
/// rather than papered over.
///
/// <b>This is an SSRF sink and is treated as one.</b> The URL comes from a model, which in turn may be
/// repeating something a user typed, so it is entirely untrusted. Defences, in order:
/// <list type="bullet">
/// <item>only <c>http</c>/<c>https</c> — no <c>file:</c>, <c>gopher:</c>, <c>ftp:</c>, no credentials in the
/// authority;</item>
/// <item>every TCP connection is pinned to an address checked at connect time by
/// <see cref="SafeConnectAsync"/>, which is what closes the DNS-rebinding window a
/// resolve-then-connect check leaves open (the resolver is free to return a public address for the check and
/// a private one for the real connection);</item>
/// <item>redirects are followed by hand so each hop is re-validated — auto-redirect would let a public URL
/// bounce to <c>169.254.169.254</c> with no second check;</item>
/// <item>a byte cap applied to DECOMPRESSED bytes, so a small gzip bomb cannot exhaust memory;</item>
/// <item>a single wall-clock deadline threaded through the body read. This is load-bearing:
/// <see cref="HttpClient.Timeout"/> stops applying once the response headers arrive under
/// <see cref="HttpCompletionOption.ResponseHeadersRead"/> (the timeout's token source is disposed at that
/// point), so a server that drips bytes forever would otherwise hang the request indefinitely.</item>
/// </list>
/// </summary>
public class UrlFetchService : IUrlFetchService
{
    /// <summary>Named HttpClient (registered in Program.cs) whose handler pins connections to vetted
    /// addresses and refuses to follow redirects on its own.</summary>
    public const string HttpClientName = "url-fetch";

    /// <summary>Cap on decompressed response bytes. Comfortably larger than any article, far below anything
    /// that would pressure the container's memory.</summary>
    private const int MaxBytes = 5 * 1024 * 1024;

    /// <summary>Cap on the markdown handed back, so one huge page can't blow out the model's context. Chosen
    /// to leave room for the conversation around it.</summary>
    private const int MaxContentChars = 60_000;

    /// <summary>Total wall-clock budget for one fetch, connect through last byte.</summary>
    private static readonly TimeSpan Deadline = TimeSpan.FromSeconds(20);

    private const int MaxRedirects = 5;

    private readonly IHttpClientFactory _http;

    public UrlFetchService(IHttpClientFactory http) => _http = http;

    public async Task<UrlFetchResult> FetchAsync(string url, CancellationToken ct)
    {
        var target = Validate(url);

        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        cts.CancelAfter(Deadline);
        var token = cts.Token;

        var client = _http.CreateClient(HttpClientName);
        var (body, contentType, finalUrl, truncated) = await ReadAsync(client, target, token, ct);

        return Extract(finalUrl, body, contentType, truncated);
    }

    // --- request ---

    /// <summary>Follow the redirect chain by hand, re-validating every hop, and read the final body under the
    /// shared deadline.</summary>
    private static async Task<(byte[] Body, string? ContentType, Uri Final, bool Truncated)> ReadAsync(
        HttpClient client, Uri target, CancellationToken token, CancellationToken callerToken)
    {
        var current = target;
        for (var hop = 0; ; hop++)
        {
            HttpResponseMessage res;
            try
            {
                using var req = new HttpRequestMessage(HttpMethod.Get, current);
                // Ordinary browser headers: many sites serve a bot wall or an empty shell without them.
                req.Headers.TryAddWithoutValidation("User-Agent",
                    "Mozilla/5.0 (compatible; EvervaultBot/1.0; +https://evervault.app)");
                req.Headers.TryAddWithoutValidation("Accept",
                    "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8");
                req.Headers.TryAddWithoutValidation("Accept-Language", "en;q=0.9,*;q=0.5");
                res = await client.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, token);
            }
            catch (UrlFetchException) { throw; }   // raised by SafeConnectAsync — already precise
            catch (OperationCanceledException) when (callerToken.IsCancellationRequested) { throw; }
            catch (Exception ex) when (ex is HttpRequestException or IOException or OperationCanceledException)
            {
                // A blocked address surfaces here wrapped, because SocketsHttpHandler wraps ConnectCallback
                // failures in HttpRequestException.
                if (Unwrap(ex) is UrlFetchException blocked) throw blocked;
                throw new UrlFetchException(UrlFetchFailure.Unreachable,
                    $"Could not reach {current.Host}.");
            }

            using (res)
            {
                if (IsRedirect(res.StatusCode) && res.Headers.Location is not null)
                {
                    if (hop >= MaxRedirects)
                        throw new UrlFetchException(UrlFetchFailure.Unreachable, "Too many redirects.");
                    var next = res.Headers.Location.IsAbsoluteUri
                        ? res.Headers.Location
                        : new Uri(current, res.Headers.Location);
                    current = Validate(next.ToString());   // re-validated: a redirect is a fresh, untrusted URL
                    continue;
                }

                if (!res.IsSuccessStatusCode)
                    throw new UrlFetchException(UrlFetchFailure.HttpError,
                        $"The site returned HTTP {(int)res.StatusCode}.");

                var contentType = res.Content.Headers.ContentType?.MediaType;
                if (!IsTextual(contentType))
                    throw new UrlFetchException(UrlFetchFailure.Unsupported,
                        $"That link is {contentType ?? "an unknown file type"}, not a web page.");

                var charset = res.Content.Headers.ContentType?.CharSet;
                var (bytes, truncated) = await ReadCappedAsync(res, token, callerToken);
                return (bytes, Combine(contentType, charset), current, truncated);
            }
        }
    }

    /// <summary>Read the body up to <see cref="MaxBytes"/>, honouring the caller's deadline on every read.
    /// The cap applies AFTER decompression, which is the only place it protects anything.</summary>
    private static async Task<(byte[] Bytes, bool Truncated)> ReadCappedAsync(
        HttpResponseMessage res, CancellationToken token, CancellationToken callerToken)
    {
        try
        {
            await using var stream = await res.Content.ReadAsStreamAsync(token);
            using var buffer = new MemoryStream();
            var chunk = new byte[81920];
            while (true)
            {
                var read = await stream.ReadAsync(chunk, token);
                if (read <= 0) break;
                var room = MaxBytes - (int)buffer.Length;
                if (read >= room)
                {
                    buffer.Write(chunk, 0, room);
                    return (buffer.ToArray(), true);
                }
                buffer.Write(chunk, 0, read);
            }
            return (buffer.ToArray(), false);
        }
        catch (OperationCanceledException) when (callerToken.IsCancellationRequested) { throw; }
        catch (Exception ex) when (ex is HttpRequestException or IOException or OperationCanceledException)
        {
            throw new UrlFetchException(UrlFetchFailure.Unreachable,
                "The page stopped responding while it was being read.");
        }
    }

    // --- extraction ---

    /// <summary>
    /// Reduce the page to its article content. SmartReader (a port of Mozilla's Readability, the same
    /// algorithm as a browser's reader mode) drops nav, ads and sidebars; the surviving subtree is converted
    /// to markdown because headings, lists, tables and links all carry meaning the model can use, and
    /// markdown keeps them at a fraction of the tokens the raw HTML would cost.
    ///
    /// Pure and public so the whole document-to-markdown step can be exercised against saved HTML without a
    /// network round-trip — extraction quality is the part of this service most worth testing directly.
    /// </summary>
    public static UrlFetchResult Extract(Uri url, byte[] body, string? contentType, bool truncated)
    {
        var text = Decode(body, contentType);

        // Plain text needs no extraction — it is already the content.
        if (contentType is not null && contentType.StartsWith("text/plain", StringComparison.OrdinalIgnoreCase))
            return new UrlFetchResult(url.ToString(), null, null, null, null, Clip(text, out var clipped),
                truncated || clipped);

        Article? article = null;
        try
        {
            // The INSTANCE api, not the static Reader.ParseArticle helper: only this form exposes the
            // thresholds, and their defaults are tuned for English. They count CHARACTERS, so a CJK article
            // — which says the same thing in far fewer of them — reads as "too short to be an article" and
            // gets discarded wholesale. Lowering them is what makes this work for non-alphabetic languages.
            article = new Reader(url.ToString(), text)
            {
                CharThreshold = 150,
            }.GetArticle();
        }
        catch
        {
            // Readability is best-effort; a page it chokes on still has its text worth salvaging below.
        }

        if (article is { IsReadable: true, Content.Length: > 0 })
        {
            var markdown = ToMarkdown(article.Content);
            if (markdown.Length > 0)
                return new UrlFetchResult(
                    url.ToString(),
                    Blank(article.Title),
                    Blank(article.Author),
                    Blank(article.SiteName),
                    article.PublicationDate is { } d ? new DateTimeOffset(d) : null,
                    Clip(markdown, out var clipped),
                    truncated || clipped);
        }

        // Not article-shaped (a homepage, a dashboard, or a client-rendered app that ships an empty shell).
        // Fall back to the whole document's text so the model gets something rather than nothing.
        var fallback = article?.TextContent;
        if (string.IsNullOrWhiteSpace(fallback)) fallback = ToMarkdown(text);
        if (string.IsNullOrWhiteSpace(fallback))
            throw new UrlFetchException(UrlFetchFailure.Unsupported,
                "That page has no readable text — it may need JavaScript to display its content.");

        return new UrlFetchResult(url.ToString(), Blank(article?.Title), null, null, null,
            Clip(fallback.Trim(), out var fallbackClipped), truncated || fallbackClipped);
    }

    private static string ToMarkdown(string html)
    {
        try
        {
            // GithubFlavored (the clean-GFM switch on the default path) rather than the GitHub *flavor*
            // enum — that one selects a writer which passes raw HTML straight through, which is the
            // opposite of what a model should be reading.
            var config = new Config { GithubFlavored = true };
            config.Tags.Unknown = Config.UnknownTagsOption.Bypass;   // keep text inside an unknown wrapper
            config.Formatting.RemoveComments = true;
            config.Links.SmartHref = true;                           // skip [text](text) for bare-URL links
            return Tidy(new Converter(config).Convert(html));
        }
        catch
        {
            return "";   // conversion is a nicety; the caller falls back to plain text
        }
    }

    /// <summary>
    /// Strip what only costs tokens. The model cannot see images, so every <c>![alt](https://…)</c> is pure
    /// context burned on a URL it can do nothing with — and on an image-heavy page (an encyclopedia article,
    /// a news front page) that is enough of the budget to push real prose past the character cap. Images go
    /// first, then the empty <c>[](…)</c> links left behind by thumbnails that linked somewhere, then runs of
    /// blank lines the removals opened up.
    /// </summary>
    private static string Tidy(string markdown)
    {
        markdown = ImageRe.Replace(markdown, "");
        markdown = EmptyLinkRe.Replace(markdown, "");
        markdown = BlankRunRe.Replace(markdown, "\n\n");
        return markdown.Trim();
    }

    private static readonly Regex ImageRe = new(@"!\[[^\]]*\]\([^)\s]*(?:\s+""[^""]*"")?\)", RegexOptions.Compiled);
    private static readonly Regex EmptyLinkRe = new(@"\[\s*\]\([^)\s]*(?:\s+""[^""]*"")?\)", RegexOptions.Compiled);
    private static readonly Regex BlankRunRe = new(@"(?:[ \t]*\r?\n){3,}", RegexOptions.Compiled);

    private static string Clip(string s, out bool clipped)
    {
        clipped = s.Length > MaxContentChars;
        return clipped ? s[..MaxContentChars] : s;
    }

    private static string? Blank(string? s) => string.IsNullOrWhiteSpace(s) ? null : s.Trim();

    /// <summary>Decode using the charset the server declared, falling back to UTF-8. Getting this wrong is
    /// what turns a CJK page into mojibake.</summary>
    private static string Decode(byte[] body, string? contentType)
    {
        var charset = contentType?.Split("charset=", StringSplitOptions.None) is { Length: > 1 } parts
            ? parts[1].Trim().Trim('"')
            : null;
        if (!string.IsNullOrWhiteSpace(charset))
        {
            try { return Encoding.GetEncoding(charset).GetString(body); }
            catch (ArgumentException) { /* unknown charset name — fall through to UTF-8 */ }
        }
        return Encoding.UTF8.GetString(body);
    }

    private static string Combine(string? mediaType, string? charset) =>
        charset is null ? mediaType ?? "" : $"{mediaType}; charset={charset}";

    private static bool IsRedirect(HttpStatusCode s) =>
        (int)s is 301 or 302 or 303 or 307 or 308;

    private static bool IsTextual(string? mediaType) =>
        mediaType is not null &&
        (mediaType.StartsWith("text/", StringComparison.OrdinalIgnoreCase)
         || mediaType.Equals("application/xhtml+xml", StringComparison.OrdinalIgnoreCase)
         || mediaType.Equals("application/xml", StringComparison.OrdinalIgnoreCase)
         || mediaType.Equals("application/json", StringComparison.OrdinalIgnoreCase));

    private static Exception? Unwrap(Exception ex)
    {
        for (var e = ex; e is not null; e = e.InnerException!)
            if (e is UrlFetchException) return e;
        return null;
    }

    // --- SSRF guards ---

    /// <summary>Syntactic validation. The address check happens later, at connect time, because only there
    /// can it be tied to the socket that is actually opened.</summary>
    private static Uri Validate(string url)
    {
        if (string.IsNullOrWhiteSpace(url))
            throw new UrlFetchException(UrlFetchFailure.Blocked, "No URL was given.");
        url = url.Trim();
        // A bare "example.com" is what people paste; assume https rather than rejecting it.
        if (!url.Contains("://", StringComparison.Ordinal)) url = "https://" + url;

        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri))
            throw new UrlFetchException(UrlFetchFailure.Blocked, "That doesn't look like a valid web address.");
        if (uri.Scheme is not ("http" or "https"))
            throw new UrlFetchException(UrlFetchFailure.Blocked, "Only http and https links can be opened.");
        // Credentials in the authority are a classic way to confuse a naive host check.
        if (!string.IsNullOrEmpty(uri.UserInfo))
            throw new UrlFetchException(UrlFetchFailure.Blocked, "That URL isn't one I can open.");
        return uri;
    }

    /// <summary>
    /// Opens the TCP connection for every request this service makes, and is the ONLY place an address is
    /// authorised. Validating here rather than before the request is deliberate: a check done up-front
    /// resolves the name once and lets <c>HttpClient</c> resolve it again for the real connection, so a
    /// resolver that returns a public address the first time and a private one the second (DNS rebinding)
    /// walks straight past it. Connecting to an address this method vetted removes that gap.
    ///
    /// TLS is untouched — the handler layers its own <c>SslStream</c> over this raw stream and takes the SNI
    /// host from the request URI, so pinning to a bare IP does not weaken certificate validation.
    /// </summary>
    public static async ValueTask<Stream> SafeConnectAsync(
        SocketsHttpConnectionContext ctx, CancellationToken ct)
    {
        var host = ctx.DnsEndPoint.Host;

        IPAddress[] resolved;
        if (IPAddress.TryParse(host, out var literal)) resolved = new[] { literal };
        else
        {
            try { resolved = await Dns.GetHostAddressesAsync(host, ct); }
            catch (SocketException)
            {
                throw new UrlFetchException(UrlFetchFailure.Unreachable, $"Could not find {host}.");
            }
        }

        var allowed = resolved.Where(IsPubliclyRoutable).ToArray();
        if (allowed.Length == 0)
            throw new UrlFetchException(UrlFetchFailure.Blocked,
                "That address is on a private network, so it can't be opened.");

        var socket = new Socket(SocketType.Stream, ProtocolType.Tcp) { NoDelay = true };
        try
        {
            // Every vetted address is offered so a dual-stack host whose first record is unreachable
            // still connects.
            await socket.ConnectAsync(allowed, ctx.DnsEndPoint.Port, ct);
            return new NetworkStream(socket, ownsSocket: true);
        }
        catch
        {
            socket.Dispose();
            throw;
        }
    }

    // Everything that is not public internet: loopback, RFC1918, carrier NAT, link-local (which covers the
    // 169.254.169.254 cloud metadata endpoint), documentation and benchmark ranges, multicast and reserved.
    private static readonly IPNetwork[] BlockedV4 =
    {
        IPNetwork.Parse("0.0.0.0/8"), IPNetwork.Parse("10.0.0.0/8"), IPNetwork.Parse("100.64.0.0/10"),
        IPNetwork.Parse("127.0.0.0/8"), IPNetwork.Parse("169.254.0.0/16"), IPNetwork.Parse("172.16.0.0/12"),
        IPNetwork.Parse("192.0.0.0/24"), IPNetwork.Parse("192.0.2.0/24"), IPNetwork.Parse("192.88.99.0/24"),
        IPNetwork.Parse("192.168.0.0/16"), IPNetwork.Parse("198.18.0.0/15"),
        IPNetwork.Parse("198.51.100.0/24"), IPNetwork.Parse("203.0.113.0/24"),
        IPNetwork.Parse("224.0.0.0/4"), IPNetwork.Parse("240.0.0.0/4"),
    };

    private static readonly IPNetwork[] BlockedV6 =
    {
        IPNetwork.Parse("::/128"), IPNetwork.Parse("::1/128"), IPNetwork.Parse("fc00::/7"),
        IPNetwork.Parse("fe80::/10"), IPNetwork.Parse("ff00::/8"), IPNetwork.Parse("2001:db8::/32"),
        IPNetwork.Parse("64:ff9b::/96"),
    };

    private static bool IsPubliclyRoutable(IPAddress ip)
    {
        // Unmap FIRST: ::ffff:127.0.0.1 is loopback wearing an IPv6 costume, and would sail past the v6
        // ranges otherwise.
        if (ip.IsIPv4MappedToIPv6) ip = ip.MapToIPv4();

        return ip.AddressFamily switch
        {
            AddressFamily.InterNetwork => !BlockedV4.Any(n => n.Contains(ip)),
            AddressFamily.InterNetworkV6 => !BlockedV6.Any(n => n.Contains(ip)),
            _ => false,
        };
    }
}

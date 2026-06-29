using System.Text.Json;
using Evervault.Api.Services.Ai.Tools;

namespace Evervault.Api.Services.Ai;

// ---- Chat DTOs (the client holds the transcript and re-sends it each turn) ----

public record ChatTurnRequest(string Provider, string Model, List<AiChatMessage> Messages);

public record ProposedAction(
    string ToolCallId,
    string ToolName,
    string ArgumentsJson,
    string HumanSummary,
    bool Dangerous,
    string Signature);

public record ConfirmActionRequest(
    string Provider,
    string Model,
    List<AiChatMessage> Messages,
    ProposedAction Action,
    string? TypedConfirmation);

public record ChatTurnResponse(
    string Status,                         // "message" | "proposal" | "error"
    string? AssistantText,
    ProposedAction? Proposal,
    string? Error,
    List<AiChatMessage> Messages)
{
    public static ChatTurnResponse Message(string text, List<AiChatMessage> m) => new("message", text, null, null, m);
    public static ChatTurnResponse Propose(ProposedAction p, List<AiChatMessage> m) => new("proposal", null, p, null, m);
    public static ChatTurnResponse Fail(string error, List<AiChatMessage> m) => new("error", null, null, error, m);
}

/// <summary>
/// The agentic loop. Read tools run automatically; the first Write tool stops the loop and is returned as
/// a confirmation proposal. Confirm re-validates the signature + danger gate server-side, executes, and
/// resumes the loop. Key failover and "all keys failed" surfacing happen via <see cref="KeyFailoverRunner"/>.
/// </summary>
public class AgentService
{
    private const int MaxIterations = 8;

    private readonly KeyFailoverRunner _failover;
    private readonly ToolRegistry _tools;
    private readonly ProposalSigner _signer;

    public AgentService(KeyFailoverRunner failover, ToolRegistry tools, ProposalSigner signer)
    {
        _failover = failover;
        _tools = tools;
        _signer = signer;
    }

    public Task<ChatTurnResponse> RunAsync(string provider, string model, List<AiChatMessage> messages, CancellationToken ct)
    {
        EnsureSystemPrompt(messages);
        return RunLoopAsync(provider, model, messages, ct);
    }

    public async Task<ChatTurnResponse> ConfirmAsync(ConfirmActionRequest req, CancellationToken ct)
    {
        var messages = req.Messages;
        EnsureSystemPrompt(messages);

        var action = req.Action;
        if (!_signer.Verify(action.Signature, action.ToolName, action.ArgumentsJson))
            return ChatTurnResponse.Fail(
                "This action could not be verified (it may have been altered or expired). Please ask again.", messages);

        var tool = _tools.Resolve(action.ToolName);
        if (tool is null || tool.Kind != AiToolKind.Write)
            return ChatTurnResponse.Fail("Unknown or invalid action.", messages);

        var args = ParseArgs(action.ArgumentsJson);
        var dangerous = Args.Bool(args, "dangerous") || tool.ForceDangerous(args);
        if (dangerous && (req.TypedConfirmation?.Trim() != "CONFIRM"))
            return ChatTurnResponse.Fail("This change is dangerous — type CONFIRM to proceed.", messages);

        string result;
        try { result = await tool.ExecuteAsync(args, ct); }
        catch (Exception ex) { result = $"Error: {ex.Message}"; }

        messages.Add(new AiChatMessage("tool", result, null, action.ToolCallId, action.ToolName));
        return await RunLoopAsync(req.Provider, req.Model, messages, ct);
    }

    private async Task<ChatTurnResponse> RunLoopAsync(string provider, string model, List<AiChatMessage> messages, CancellationToken ct)
    {
        for (var iter = 0; iter < MaxIterations; iter++)
        {
            AiCompletion completion;
            try
            {
                completion = await _failover.RunAsync(provider,
                    (p, key) => p.CompleteAsync(key, model, messages, _tools.Schemas(), ct));
            }
            catch (AllKeysFailedException ex)
            {
                var detail = ex.Errors.Count > 0 ? string.Join("\n", ex.Errors.Select(e => "• " + e)) : ex.Message;
                return ChatTurnResponse.Fail($"All {provider} keys failed:\n{detail}", messages);
            }
            catch (AiProviderException ex)
            {
                return ChatTurnResponse.Fail(ex.Message, messages);
            }

            if (completion.ToolCalls.Count == 0)
            {
                var text = completion.Text ?? "";
                messages.Add(new AiChatMessage("assistant", text));
                return ChatTurnResponse.Message(text, messages);
            }

            // Process tool calls in order: run reads, stop at the first write.
            var accounted = new List<AiToolCall>();
            var readResults = new List<AiChatMessage>();
            AiToolCall? writeCall = null;

            foreach (var call in completion.ToolCalls)
            {
                var tool = _tools.Resolve(call.Name);
                if (tool is null)
                {
                    accounted.Add(call);
                    readResults.Add(new AiChatMessage("tool", $"Error: unknown tool '{call.Name}'.", null, call.Id, call.Name));
                    continue;
                }
                if (tool.Kind == AiToolKind.Read)
                {
                    accounted.Add(call);
                    string result;
                    try { result = await tool.ExecuteAsync(ParseArgs(call.ArgumentsJson), ct); }
                    catch (Exception ex) { result = $"Error: {ex.Message}"; }
                    readResults.Add(new AiChatMessage("tool", result, null, call.Id, call.Name));
                }
                else
                {
                    accounted.Add(call);   // the write is recorded; its result arrives on confirm
                    writeCall = call;
                    break;                 // ignore any further calls in this turn for an unambiguous confirm
                }
            }

            messages.Add(new AiChatMessage("assistant", completion.Text, accounted));
            messages.AddRange(readResults);

            if (writeCall is not null)
            {
                var tool = _tools.Resolve(writeCall.Name)!;
                var args = ParseArgs(writeCall.ArgumentsJson);
                var dangerous = Args.Bool(args, "dangerous") || tool.ForceDangerous(args);
                var summary = Args.Str(args, "change_summary") ?? tool.Summarize(args);
                var signature = _signer.Sign(writeCall.Name, writeCall.ArgumentsJson);
                var proposal = new ProposedAction(writeCall.Id, writeCall.Name, writeCall.ArgumentsJson, summary, dangerous, signature);
                return ChatTurnResponse.Propose(proposal, messages);
            }
            // all reads — loop again so the model can use the data
        }

        var capMsg = "(Stopped after reaching the maximum number of tool steps. Ask me to continue if needed.)";
        messages.Add(new AiChatMessage("assistant", capMsg));
        return ChatTurnResponse.Message(capMsg, messages);
    }

    private static void EnsureSystemPrompt(List<AiChatMessage> messages)
    {
        messages.RemoveAll(m => m.Role == "system");
        messages.Insert(0, new AiChatMessage("system", SystemPrompt));
    }

    private const string SystemPrompt =
        """
        You are the admin assistant for Evervault, a personal memory app. You help the signed-in admin
        inspect and manage the system from a chat box inside the /admin control panel.

        Tools:
        - READ tools (list_memories, get_memory, search_memories, db_stats, get_storage_status,
          get_ai_keys_status, sql_query) run automatically. Use them freely to answer questions — never
          ask for permission to read or look something up.
        - WRITE tools (create_memory, update_memory, delete_memory, update_storage_config, sql_exec) modify
          the database. They are NOT executed when you call them — instead the admin sees a confirmation
          card and must approve. When you call a write tool you MUST include a clear `change_summary`
          stating exactly what will change, and set `dangerous: true` when the change is destructive,
          irreversible, bulk/unscoped, or touches credentials/config. Propose only ONE write at a time.

        Guidance:
        - For data lookups prefer the specific tools; use sql_query for anything ad-hoc (read-only SELECT).
        - Secrets (API keys, password hashes, encrypted values) are never readable — don't try.
        - Be concise. After a change is confirmed and executed, briefly confirm what happened.
        """;

    private static JsonElement ParseArgs(string json)
    {
        try
        {
            using var doc = JsonDocument.Parse(string.IsNullOrWhiteSpace(json) ? "{}" : json);
            return doc.RootElement.Clone();
        }
        catch
        {
            using var doc = JsonDocument.Parse("{}");
            return doc.RootElement.Clone();
        }
    }
}

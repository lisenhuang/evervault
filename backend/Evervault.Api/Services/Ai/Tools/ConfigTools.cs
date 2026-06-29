using System.Text.Json;
using Evervault.Api.Services;

namespace Evervault.Api.Services.Ai.Tools;

// ---- Read tools (already secret-safe: the services mask secrets) ----

public class GetStorageStatusTool : IAiTool
{
    private readonly IStorageService _storage;
    public GetStorageStatusTool(IStorageService storage) => _storage = storage;

    public string Name => "get_storage_status";
    public string Description => "Current Cloudflare R2 storage configuration (the secret is masked).";
    public string ParametersJson => """{"type":"object","properties":{}}""";
    public AiToolKind Kind => AiToolKind.Read;

    public async Task<string> ExecuteAsync(JsonElement args, CancellationToken ct)
    {
        var dto = await _storage.GetAsync();
        return dto is null ? "No storage configured yet." : JsonSerializer.Serialize(dto);
    }
}

public class GetAiKeysStatusTool : IAiTool
{
    private readonly IAiKeyService _keys;
    public GetAiKeysStatusTool(IAiKeyService keys) => _keys = keys;

    public string Name => "get_ai_keys_status";
    public string Description => "Configured AI provider keys with their validity status (keys are masked).";
    public string ParametersJson => """{"type":"object","properties":{}}""";
    public AiToolKind Kind => AiToolKind.Read;

    public async Task<string> ExecuteAsync(JsonElement args, CancellationToken ct)
        => JsonSerializer.Serialize(await _keys.GetAsync());
}

// ---- Write tool ----

public class UpdateStorageConfigTool : IAiTool
{
    private readonly IStorageService _storage;
    public UpdateStorageConfigTool(IStorageService storage) => _storage = storage;

    public string Name => "update_storage_config";
    public string Description => "Update the Cloudflare R2 storage configuration. Omit 'secret' to keep the existing one.";
    public string ParametersJson => """
    {"type":"object","properties":{
      "accountId":{"type":"string"},"accessKeyId":{"type":"string"},"secret":{"type":"string"},
      "bucket":{"type":"string"},"endpoint":{"type":"string"},"publicBaseUrl":{"type":"string"},
      "jurisdiction":{"type":"string"},
      "change_summary":{"type":"string"},"dangerous":{"type":"boolean"}
    },"required":["accountId","accessKeyId","bucket","change_summary"]}
    """;
    public AiToolKind Kind => AiToolKind.Write;

    // Overwriting storage credentials can break uploads — always require the typed CONFIRM gate.
    public bool ForceDangerous(JsonElement args) => true;

    public string Summarize(JsonElement args) =>
        $"Overwrite R2 storage config (bucket: {Args.Str(args, "bucket")}).";

    public async Task<string> ExecuteAsync(JsonElement args, CancellationToken ct)
    {
        var input = new StorageConfigInput(
            AccountId: Args.Str(args, "accountId") ?? "",
            AccessKeyId: Args.Str(args, "accessKeyId") ?? "",
            Secret: Args.Str(args, "secret"),
            Bucket: Args.Str(args, "bucket") ?? "",
            Endpoint: Args.Str(args, "endpoint"),
            Region: null,
            PublicBaseUrl: Args.Str(args, "publicBaseUrl"),
            Jurisdiction: Args.Str(args, "jurisdiction"));
        await _storage.SaveAsync(input);
        return "Storage configuration saved.";
    }
}

import { useI18n } from "../../i18n/I18nProvider";
import { useRef, useState } from "react";
import type { AcpConfigOption, AiProviderConfig } from "../../../contracts/ai-contracts";
import type { AiGateway } from "../../../application/ports";
import { describeInvokeError } from "../../../domain/ai-config";
import type { LocalizedText } from "../../../contracts/localization";
import { localizedFailure, renderLocalizedText } from "../../../domain/localization";
import { aiProviderId } from "../../../domain/ai-view-preferences";
import type { AiProviderId, AdvertisedAiProvider } from "../../../contracts/ai-view-preferences";

/** Share explicit agent discovery across both chat surfaces, fencing stale connection results. */
export function useAiModels(provider: AiProviderConfig, gateway?: AiGateway, scopeKey?: string | null) {
  const { t } = useI18n();
  const providerId = aiProviderId(provider);
  const connection = JSON.stringify({ kind: provider.kind, preset: provider.acp?.preset, argv: provider.acp?.argv, scope: scopeKey ?? null });
  const current = useRef(connection);
  current.current = connection;
  const attempt = useRef(0);
  const inFlight = useRef(new Set<string>());
  const [results, setResults] = useState<Record<string, { provider: AiProviderId; options: AcpConfigOption[]; error: LocalizedText | null }>>({});
  const result = results[connection];
  const [pending, setPending] = useState<string | null>(null);
  /** Retain the actual discovery for this configuration and replace older metadata for the same adapter. */
  function noteDiscovery(options: AcpConfigOption[], error: LocalizedText | null) {
    setResults((previous) => ({
      ...Object.fromEntries(Object.entries(previous).filter(([, entry]) => entry.provider !== providerId)),
      [connection]: { provider: providerId, options: error === null ? options : previous[connection]?.options ?? [], error },
    }));
  }
  /** Start a user-requested, isolated handshake without sending document contents or a prompt. */
  async function refresh() {
    if (!gateway || provider.kind !== "acp" || inFlight.current.has(connection)) return;
    const token = ++attempt.current;
    const requested = connection;
    inFlight.current.add(requested);
    setPending(requested);
    try {
      const reply = await gateway.testConnection(provider, true);
      if (current.current !== requested || attempt.current !== token) return;
      noteDiscovery(reply.ok ? reply.configOptions ?? [] : [], reply.ok ? null : reply.detail);
    } catch (cause) {
      if (current.current === requested && attempt.current === token) {
        noteDiscovery([], localizedFailure(cause, describeInvokeError));
      }
    } finally {
      inFlight.current.delete(requested);
      if (attempt.current === token) setPending(null);
    }
  }
  return {
    options: result?.options ?? [],
    error: result && result.error !== null ? renderLocalizedText(result.error, t) : null,
    discovered: result !== undefined,
    advertisedProviders: Object.entries(results).filter(([key, entry]) => entry.provider !== providerId || key === connection).map(([, entry]): AdvertisedAiProvider => ({ provider: entry.provider, options: entry.options, discovered: entry.error === null })),
    loading: pending === connection,
    refresh,
  };
}

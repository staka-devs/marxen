import { useI18n } from "../../i18n/I18nProvider";
import { useRef, useState } from "react";
import type { AcpConfigOption, AiProviderConfig } from "../../../contracts/ai-contracts";
import type { AiGateway } from "../../../application/ports";
import { describeInvokeError } from "../../../domain/ai-config";
import type { LocalizedText } from "../../../contracts/localization";
import { localizedFailure, renderLocalizedText } from "../../../domain/localization";

/** Share explicit agent discovery across both chat surfaces, fencing stale connection results. */
export function useAiModels(provider: AiProviderConfig, gateway?: AiGateway) {
  const { t } = useI18n();
  const connection = JSON.stringify({ kind: provider.kind, preset: provider.acp?.preset, argv: provider.acp?.argv });
  const current = useRef(connection);
  current.current = connection;
  const attempt = useRef(0);
  const [result, setResult] = useState<{ connection: string; options: AcpConfigOption[]; error: LocalizedText | null } | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  /** Start a user-requested, isolated handshake without sending document contents or a prompt. */
  async function refresh() {
    if (!gateway || provider.kind !== "acp" || pending === connection) return;
    const token = ++attempt.current;
    const requested = connection;
    setPending(requested);
    try {
      const reply = await gateway.testConnection(provider, true);
      if (current.current !== requested || attempt.current !== token) return;
      setResult({ connection: requested, options: reply.ok ? reply.configOptions ?? [] : [], error: reply.ok ? null : reply.detail });
    } catch (cause) {
      if (current.current === requested && attempt.current === token) {
        setResult({ connection: requested, options: [], error: localizedFailure(cause, describeInvokeError) });
      }
    } finally {
      if (attempt.current === token) setPending(null);
    }
  }
  return {
    options: result?.connection === connection ? result.options : [],
    error: result?.connection === connection && result.error !== null ? renderLocalizedText(result.error, t) : null,
    discovered: result?.connection === connection,
    loading: pending === connection,
    refresh,
  };
}

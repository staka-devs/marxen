import { useCallback, useEffect, useRef, useState } from "react";
import type { CodexAccountUsageGateway } from "../../application/ai/usage-ports";
import type { CodexAccountUsage } from "../../contracts/ai-contracts";

/** Read quota metadata while its popup is open, fencing late and superseded responses. */
export function useCodexAccountUsage(gateway?: CodexAccountUsageGateway) {
  const [usage, setUsage] = useState<CodexAccountUsage>();
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const generation = useRef(0);
  const request = useRef(0);
  /** Re-read official account limits without starting inference. */
  const refresh = useCallback(async () => {
    if (!gateway) return;
    const scope = generation.current;
    const ticket = ++request.current;
    setLoading(true);
    try {
      const result = await gateway.read();
      if (scope === generation.current && ticket === request.current) { setUsage(result); setFailed(false); }
    } catch {
      if (scope === generation.current && ticket === request.current) setFailed(true);
    } finally {
      if (scope === generation.current && ticket === request.current) setLoading(false);
    }
  }, [gateway]);
  useEffect(() => {
    generation.current += 1;
    setUsage(undefined); setLoading(false); setFailed(false);
    void refresh();
    return () => { generation.current += 1; };
  }, [gateway, refresh]);
  return { usage, loading, failed, refresh };
}

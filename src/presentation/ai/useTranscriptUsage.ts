import { useCallback, useEffect, useRef, useState } from "react";
import type { TranscriptUsageGateway } from "../../application/ai/usage-ports";
import type { TranscriptUsageReport } from "../../contracts/ai-contracts";

/** Read local transcript totals while its popup is open, fencing late and superseded responses. */
export function useTranscriptUsage(gateway?: TranscriptUsageGateway) {
  const [report, setReport] = useState<TranscriptUsageReport>();
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const generation = useRef(0);
  const request = useRef(0);
  /** Re-scan default transcript stores without starting inference. */
  const refresh = useCallback(async () => {
    if (!gateway) return;
    const scope = generation.current;
    const ticket = ++request.current;
    setLoading(true);
    try {
      const result = await gateway.read();
      if (scope === generation.current && ticket === request.current) { setReport(result); setFailed(false); }
    } catch {
      if (scope === generation.current && ticket === request.current) setFailed(true);
    } finally {
      if (scope === generation.current && ticket === request.current) setLoading(false);
    }
  }, [gateway]);
  useEffect(() => {
    generation.current += 1;
    setReport(undefined); setLoading(false); setFailed(false);
    void refresh();
    return () => { generation.current += 1; };
  }, [gateway, refresh]);
  return { report, loading, failed, refresh };
}

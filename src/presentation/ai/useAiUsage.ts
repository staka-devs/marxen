import { useCallback, useEffect, useRef, useState } from "react";
import type { AiUsageGateway } from "../../application/ai/usage-ports";
import type { ReportedUsage } from "../../contracts/ai-contracts";
import { latestAgentUsage, rememberUsage } from "../../domain/ai-usage";

/** Observe reported usage while open and fence refreshes from previous mounts. */
export function useAiUsage(gateway: AiUsageGateway) {
  const [reports, setReports] = useState<ReportedUsage[]>([]);
  const [loading, setLoading] = useState(false);
  const [readFailed, setReadFailed] = useState(false);
  const [subscriptionFailed, setSubscriptionFailed] = useState(false);
  const generation = useRef(0);
  const request = useRef(0);

  /** Read retained observations, preserving newer events received during the read. */
  const refresh = useCallback(async () => {
    const scope = generation.current;
    const ticket = ++request.current;
    setLoading(true);
    try {
      const snapshot = await gateway.snapshot();
      if (scope !== generation.current || ticket !== request.current) return;
      setReports((current) => current.reduce(rememberUsage, snapshot));
      setReadFailed(false);
    } catch {
      if (scope === generation.current && ticket === request.current) setReadFailed(true);
    } finally {
      if (scope === generation.current && ticket === request.current) setLoading(false);
    }
  }, [gateway]);

  useEffect(() => {
    const scope = ++generation.current;
    let unlisten: (() => void) | undefined;
    setReports([]);
    setReadFailed(false);
    setSubscriptionFailed(false);
    gateway.subscribe((report) => {
      if (scope === generation.current) setReports((current) => rememberUsage(current, report));
    }).then((cleanup) => {
      if (scope !== generation.current) cleanup();
      else unlisten = cleanup;
    }).catch(() => {
      if (scope === generation.current) setSubscriptionFailed(true);
    });
    void refresh();
    return () => { generation.current += 1; unlisten?.(); };
  }, [gateway, refresh]);

  return { agents: latestAgentUsage(reports), loading, failed: readFailed || subscriptionFailed, refresh };
}

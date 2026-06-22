import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

type LiveTopic = "jobs" | "orchestrator-runs";

function invalidateTopic(queryClient: QueryClient, topic: LiveTopic) {
  if (topic === "jobs") {
    queryClient.invalidateQueries({ queryKey: ["jobs", "list"] });
    queryClient.invalidateQueries({ queryKey: ["dependabot", "list"] });
    return;
  }
  queryClient.invalidateQueries({ queryKey: ["orchestrator", "runs"] });
}

function invalidateTopics(queryClient: QueryClient, topics: LiveTopic[]) {
  for (const topic of topics) invalidateTopic(queryClient, topic);
}

export function useLiveUpdates(topics: LiveTopic[]) {
  const queryClient = useQueryClient();
  const topicKey = topics.join(",");

  useEffect(() => {
    const activeTopics = topicKey.split(",").filter(Boolean) as LiveTopic[];
    if (activeTopics.length === 0) return;
    const source = new EventSource("/api/live");
    const settleTimers = new Set<ReturnType<typeof setTimeout>>();

    function invalidateNowAndSettled(topic: LiveTopic) {
      invalidateTopic(queryClient, topic);
      const timer = setTimeout(() => {
        settleTimers.delete(timer);
        invalidateTopic(queryClient, topic);
      }, 750);
      settleTimers.add(timer);
    }

    source.addEventListener("connected", () => invalidateTopics(queryClient, activeTopics));

    for (const topic of activeTopics) {
      source.addEventListener(topic, () => invalidateNowAndSettled(topic));
    }

    return () => {
      source.close();
      for (const timer of settleTimers) clearTimeout(timer);
    };
  }, [queryClient, topicKey]);
}

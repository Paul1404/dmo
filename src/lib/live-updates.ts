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

export function useLiveUpdates(topics: LiveTopic[]) {
  const queryClient = useQueryClient();
  const topicKey = topics.join(",");

  useEffect(() => {
    const activeTopics = topicKey.split(",").filter(Boolean) as LiveTopic[];
    if (activeTopics.length === 0) return;
    const source = new EventSource("/api/live");

    for (const topic of activeTopics) {
      source.addEventListener(topic, () => invalidateTopic(queryClient, topic));
    }

    return () => source.close();
  }, [queryClient, topicKey]);
}

import { Connection, Client } from "@temporalio/client";

const runId = process.argv[2];
if (!runId) {
  console.error("Usage: tsx scripts/start-creative-run.ts <runId>");
  process.exit(1);
}
const workflowId = `creative-run-${runId}`;

async function main() {
  const connection = await Connection.connect({ address: process.env.TEMPORAL_ADDRESS ?? "127.0.0.1:7233" });
  const client = new Client({ connection, namespace: process.env.TEMPORAL_NAMESPACE ?? "default" });
  const handle = await client.workflow.start("creativeRunWorkflow", {
    args: [runId],
    taskQueue: process.env.TEMPORAL_TASK_QUEUE ?? "novel-v2",
    workflowId,
  });
  console.log(JSON.stringify({ workflowId, firstExecutionRunId: handle.firstExecutionRunId }));
  await connection.close();
}

main().catch((error) => {
  console.error("Failed to start workflow:", error);
  process.exit(1);
});

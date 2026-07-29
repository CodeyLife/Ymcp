import { Connection, Client } from "@temporalio/client";

const workflowId = process.argv[2];
if (!workflowId) {
  console.error("Usage: tsx scripts/terminate-workflow.ts <workflowId>");
  process.exit(1);
}

async function main() {
  const connection = await Connection.connect({ address: process.env.TEMPORAL_ADDRESS ?? "127.0.0.1:7233" });
  const client = new Client({ connection, namespace: process.env.TEMPORAL_NAMESPACE ?? "default" });
  const handle = client.workflow.getHandle(workflowId);
  await handle.terminate("terminated by scripts/terminate-workflow.ts");
  console.log(JSON.stringify({ workflowId, terminated: true }));
  await connection.close();
}

main().catch((error) => {
  console.error("Failed to terminate workflow:", error);
  process.exit(1);
});

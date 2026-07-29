import { ModelConfigStore } from "./model-config-store";
import { RoutedModelGateway } from "./model-gateway";
import type { NovelPostgresRepository } from "./postgres-repository";

export async function createRuntimeModelGateway(repository: NovelPostgresRepository) {
  const configStore = new ModelConfigStore();
  await configStore.load();
  await repository.projectModelRoutingConfig(configStore.getConfig(), configStore.getSnapshot());
  const gateway = new RoutedModelGateway(configStore, (audit) => repository.recordModelInvocation(audit));
  return { configStore, gateway };
}

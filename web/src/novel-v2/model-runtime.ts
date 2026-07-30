import { ModelConfigStore } from "./model-config-store";
import { RoutedModelGateway } from "./model-gateway";
import type { NovelPostgresRepository } from "./postgres-repository";
import type { ObjectStoreAdapter } from "./object-store";

export async function createRuntimeModelGateway(repository: NovelPostgresRepository, objects?: ObjectStoreAdapter) {
  const configStore = new ModelConfigStore();
  await configStore.load();
  await repository.projectModelRoutingConfig(configStore.getConfig(), configStore.getSnapshot());
  const gateway = new RoutedModelGateway(
    configStore,
    (audit) => repository.recordModelInvocation(audit),
    objects ? (execution) => repository.recordPromptExecution(execution, objects) : undefined,
  );
  return { configStore, gateway };
}

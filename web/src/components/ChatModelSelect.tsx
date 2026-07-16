import { useEffect, useMemo, useState } from "react";
import { Select } from "antd";
import type { SelectProps } from "antd";
import { listChatModels } from "@/lib/api";
import { getEffectiveApiConfig } from "@/stores/ui";

let cachedModels: string[] | undefined;
let pendingModels: Promise<string[]> | undefined;

function loadModels() {
  if (cachedModels) return Promise.resolve(cachedModels);
  if (!pendingModels) {
    pendingModels = listChatModels(getEffectiveApiConfig())
      .then((models) => (cachedModels = models))
      .finally(() => { pendingModels = undefined; });
  }
  return pendingModels;
}

export function ChatModelSelect({ value = "gpt-5-5", onChange, ...props }: SelectProps<string>) {
  const [models, setModels] = useState<string[]>(cachedModels ?? []);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    loadModels()
      .then((items) => { if (active) setModels(items); })
      .catch(() => undefined)
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  const options = useMemo(() => {
    const values = ["auto", value, ...models].filter(Boolean);
    return [...new Set(values)].map((model) => ({
      value: model,
      label: model === "auto" ? "auto（自动选择）" : model,
    }));
  }, [models, value]);

  return <Select<string> {...props} value={value} onChange={onChange} options={options} loading={loading} showSearch optionFilterProp="label" popupMatchSelectWidth={false} />;
}

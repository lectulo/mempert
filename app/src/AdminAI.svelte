<script lang="ts">
  import { Alert, Button, Heading, Select, Spinner, Stack, Text, TextField } from "@cofob2/design-system-svelte";
  import { onMount } from "svelte";
  import { api, ApiError, AI_WORKLOADS, type AIModel, type AIRoute, type AISettings, type AISettingUpdate, type AIWorkload } from "./api";
  import { fill, isRu, s } from "./strings";
  import { confirm } from "./telegram";

  const credentialText = isRu ? {
    missing: "Для некоторых функций ИИ нет сохранённого ключа",
    present: "Ключ сохранён; его работоспособность не проверена.",
    openRouter: "Эмбеддинги и общие пакетные задания OpenRouter (независимо от маршрутов ниже)",
    cutover: "Переход на сохранённые ключи",
    instructions: "После обновления ключи из переменных окружения не переносятся автоматически. Сохраните ключи для используемых провайдеров здесь и проверьте работу нужных функций.",
    batches: "Если ещё открыты старые общие пакетные задания OpenRouter, перед первым сохранением убедитесь, что у вас есть именно исходный ключ OpenRouter, которым они были отправлены. Новый ключ не подходит. Если исходный ключ нельзя подтвердить, дождитесь завершения заданий на старой версии до обновления. Не меняйте сохранённый ключ, пока задания не завершены.",
  } : {
    missing: "Some AI features have no stored key",
    present: "Key stored; it has not been verified.",
    openRouter: "OpenRouter embeddings and shared batch jobs (independent of the routes below)",
    cutover: "Moving to stored API keys",
    instructions: "Environment keys are not carried over automatically on upgrade. Save the keys for the providers you use here, then test the features that depend on them.",
    batches: "If any old shared OpenRouter batches are still open, verify that you have the exact original OpenRouter key that submitted them before saving it here for the first time. A new key will not work. If you cannot verify the original key, finish those batches on the old version before upgrading. Do not rotate the stored key until the batches finish.",
  };

  let { onSaved }: { onSaved: () => void } = $props();
  let settings = $state<AISettings>();
  let busy = $state(false);
  let message = $state<{ tone: "danger" | "success"; text: string }>();

  let providerEdit = $state("");
  const addProvider = "+";
  let name = $state("");
  let newId = $state("");
  let newBaseUrl = $state("");
  let key = $state("");
  let modelEdit = $state("");
  let providerId = $state("");
  let model = $state("");
  let prices = $state({ prompt: "0", completion: "0", cacheWrite: "0", cacheRead: "0" });
  const priceFields = ["prompt", "completion", "cacheWrite", "cacheRead"] as const;
  let draftRoutes = $state<Partial<Record<AIWorkload, string>>>({});

  const routeKey = ({ providerId, model }: AIRoute) => JSON.stringify([providerId, model]);
  const providersWithKey = $derived(new Set(settings?.providers.filter((p) => p.hasKey).map((p) => p.id)));
  const missingRoutes = $derived(AI_WORKLOADS.filter((workload) => {
    const route = settings?.routes[workload];
    return route && !providersWithKey.has(route.providerId);
  }));
  const routeLabel = ({ providerId, model }: AIRoute) =>
    `${providerId} / ${model}${providersWithKey.has(providerId) ? "" : ` — ${s.adminAiNoKey}`}`;
  const modelOptions = $derived(settings?.models.map((m) => ({ value: routeKey(m), label: routeLabel(m) })) ?? []);
  const chosenProvider = $derived(settings?.providers.find((p) => p.id === providerEdit));
  const chosenModel = $derived(settings?.models.find((m) => routeKey(m) === modelEdit));
  // Use saved routes, not drafts: choosing a new model does not reroute a workload until saved.
  function dependentRoutes(id: string, modelId?: string) {
    return AI_WORKLOADS.filter((workload) => {
      const route = settings?.routes[workload];
      return route?.providerId === id && (modelId === undefined || route.model === modelId);
    });
  }
  const providerDependencies = $derived(chosenProvider ? dependentRoutes(chosenProvider.id) : []);
  const modelDependencies = $derived(chosenModel ? dependentRoutes(chosenModel.providerId, chosenModel.model) : []);

  async function refresh() {
    settings = await api.adminAI();
    const availableModels = new Set(settings.models.map(routeKey));
    for (const workload of AI_WORKLOADS) {
      const draft = draftRoutes[workload];
      if (draft && !availableModels.has(draft)) delete draftRoutes[workload];
    }
  }

  async function load() {
    busy = true;
    message = undefined;
    try { await refresh(); }
    catch { message = { tone: "danger", text: s.adminAiLoadError }; }
    finally { busy = false; }
  }
  onMount(() => { void load(); });

  async function save(update: AISettingUpdate, afterSave?: () => void) {
    if (busy) return;
    busy = true;
    message = undefined;
    try {
      await api.saveAdminAI(update);
      afterSave?.();
      onSaved();
      try {
        await refresh();
        message = { tone: "success", text: s.stateReady };
      } catch {
        settings = undefined;
        message = { tone: "danger", text: s.adminAiRefreshError };
      }
    } catch (error) {
      const blocked = update.action === "provider" && update.id === "openrouter" && error instanceof ApiError && error.status === 409;
      const badNew = update.action === "provider_create" && error instanceof ApiError && error.status === 400;
      const deleteConflict = (update.action === "deleteProvider" || update.action === "deleteModel") && error instanceof ApiError && error.status === 409;
      if (deleteConflict) await refresh().catch(() => {});
      message = { tone: "danger", text: blocked ? s.adminAiBatchKeyInUse : badNew ? s.adminAiAddError : deleteConflict ? s.adminAiDeleteConflict : s.adminAiSaveError };
    } finally { busy = false; }
  }

  async function confirmDeletion(text: string) {
    busy = true;
    try { return await confirm(text); }
    finally { busy = false; }
  }

  async function deleteProvider() {
    const id = chosenProvider?.id;
    if (busy || !id || id === "openrouter" || providerDependencies.length) return;
    if (!(await confirmDeletion(fill(s.adminAiDeleteProviderConfirm, { id })))) return;
    void save({ action: "deleteProvider", id }, () => {
      chooseProvider("");
      if (providerId === id) chooseModel("");
    });
  }

  async function deleteModel() {
    if (busy || !chosenModel || chosenModel.deleteProtected || modelDependencies.length) return;
    const { providerId, model } = chosenModel;
    if (!(await confirmDeletion(fill(s.adminAiDeleteModelConfirm, { id: providerId, model })))) return;
    void save({ action: "deleteModel", providerId, model }, () => chooseModel(""));
  }

  function chooseProvider(value: string) {
    providerEdit = value;
    const p = settings?.providers.find((item) => item.id === value);
    name = p?.name ?? "";
    key = "";
    newId = "";
    newBaseUrl = "";
  }

  const validNewId = $derived(/^[a-z][a-z\d_-]{0,63}$/.test(newId.trim()) && !settings?.providers.some((p) => p.id === newId.trim()));
  function createProvider() {
    const id = newId.trim();
    if (!validNewId || !name.trim() || !newBaseUrl.trim() || !key.trim()) return;
    void save({ action: "provider_create", id, name: name.trim(), baseUrl: newBaseUrl.trim(), key: key.trim() }, () => {
      providerEdit = id;
      key = "";
      newId = "";
      newBaseUrl = "";
    });
  }

  function chooseModel(value: string) {
    modelEdit = value;
    const m = settings?.models.find((item) => routeKey(item) === value);
    providerId = m?.providerId ?? "";
    model = m?.model ?? "";
    for (const field of priceFields) prices[field] = String(m?.[field] ?? 0);
  }

  const validPrices = $derived(priceFields.every((field) => prices[field].trim() && Number.isFinite(Number(prices[field])) && Number(prices[field]) >= 0));
  function saveModel() {
    if (!validPrices || !providerId || !model.trim()) return;
    const values = Object.fromEntries(priceFields.map((field) => [field, Number(prices[field])])) as Pick<AIModel, typeof priceFields[number]>;
    void save({ action: "model", providerId, model: model.trim(), ...values }, () => { modelEdit = routeKey({ providerId, model: model.trim() }); });
  }

  function saveRoute(workload: AIWorkload) {
    const target = settings?.models.find((m) => routeKey(m) === draftRoutes[workload]);
    if (target) void save({ action: "route", workload, providerId: target.providerId, model: target.model }, () => { delete draftRoutes[workload]; });
  }
</script>

{#snippet deletionDependencies(workloads: AIWorkload[])}
  {#if workloads.length}
    <Text tone="muted" size="sm">{s.adminAiDeleteReroute}</Text>
    <ul class="workload-list">
      {#each workloads as workload (workload)}
        <li>{s.adminAiWorkloads[workload]} ({settings?.routes[workload]?.model})</li>
      {/each}
    </ul>
  {/if}
{/snippet}

<Heading as="h3" size="sm">{s.adminAiTitle}</Heading>
{#if message}<Alert tone={message.tone} title={message.text} />{/if}
{#if !settings}
  {#if busy || !message}<Spinner label={s.adminAiTitle} />
  {:else}<Button size="sm" variant="secondary" onclick={load}>{s.retry}</Button>{/if}
{:else}
  {#if !providersWithKey.has("openrouter") || missingRoutes.length}
    <Alert tone="warning" title={credentialText.missing}>
      <ul class="workload-list">
        {#if !providersWithKey.has("openrouter")}<li>{credentialText.openRouter}</li>{/if}
        {#each missingRoutes as workload (workload)}
          <li>{s.adminAiWorkloads[workload]} ({settings.routes[workload]?.providerId})</li>
        {/each}
      </ul>
    </Alert>
  {/if}
  <details open={!providersWithKey.has("openrouter")}>
    <summary>{credentialText.cutover}</summary>
    <Stack gap="sm">
      <Text size="sm">{credentialText.instructions}</Text>
      <Text size="sm">{credentialText.batches}</Text>
    </Stack>
  </details>
  <details>
    <summary>{s.adminAiProviders}</summary>
    <Stack gap="sm">
      <Select label={s.adminAiProvider} value={providerEdit} disabled={busy}
        options={[{ value: "", label: s.adminAiChoose }, { value: addProvider, label: s.adminAiAddProvider }, ...settings.providers.map((p) => ({ value: p.id, label: `${p.name} (${p.id})${p.hasKey ? "" : ` — ${s.adminAiNoKey}`}` }))]}
        onchange={(e) => chooseProvider((e.currentTarget as HTMLSelectElement).value)} />
      {#if providerEdit === addProvider}
        <TextField label={s.adminAiProviderId} size="sm" bind:value={newId} disabled={busy} />
        <Text tone="muted" size="sm">{s.adminAiProviderIdHint}</Text>
        <TextField label={s.adminAiName} size="sm" bind:value={name} disabled={busy} />
        <TextField label={s.adminAiBaseUrl} size="sm" bind:value={newBaseUrl} type="url" disabled={busy} />
        <Text tone="muted" size="sm">{s.adminAiNewBaseUrlHint}</Text>
        <TextField label={s.adminAiKey} size="sm" bind:value={key} type="password" autocomplete="new-password" disabled={busy} />
        <Button size="sm" disabled={busy || !validNewId || !name.trim() || !newBaseUrl.trim() || !key.trim()} onclick={createProvider}>{s.adminAiAddProvider}</Button>
      {:else if chosenProvider}
        {@const { id, baseUrl, hasKey, keyPreview } = chosenProvider}
        <TextField label={s.adminAiName} size="sm" bind:value={name} disabled={busy} />
        <TextField label={s.adminAiBaseUrl} size="sm" value={baseUrl} readonly />
        <Text tone="muted" size="sm">{s.adminAiFixedBaseUrlHint}</Text>
        <TextField label={s.adminAiKey} size="sm" bind:value={key} type="password" autocomplete="new-password" disabled={busy} />
        {#if hasKey}
          <Text tone="muted" size="sm">{credentialText.present} {#if keyPreview}<code>{keyPreview}</code>{:else}{s.adminAiNoKeyPreview}{/if}</Text>
          <Text tone="muted" size="sm">{s.adminAiKeepKey}</Text>
        {:else}
          <Text tone="muted" size="sm">{s.adminAiNoKey}</Text>
        {/if}
        <Button size="sm" disabled={busy || !name.trim()}
          onclick={() => save({ action: "provider", id, name: name.trim(), ...(key.trim() ? { key: key.trim() } : {}) }, () => { key = ""; })}>{s.save}</Button>
        {#if id === "openrouter"}
          <Text tone="muted" size="sm">{s.adminAiProtectedProvider}</Text>
        {/if}
        {@render deletionDependencies(providerDependencies)}
        <Button size="sm" variant="danger" disabled={busy || id === "openrouter" || !!providerDependencies.length} onclick={deleteProvider}>{s.adminAiDeleteProvider}</Button>
      {/if}
    </Stack>
  </details>
  <details>
    <summary>{s.adminAiModels}</summary>
    <Stack gap="sm">
      <Select label={s.adminAiModel} value={modelEdit} disabled={busy}
        options={[{ value: "", label: s.adminAiNewModel }, ...modelOptions]}
        onchange={(e) => chooseModel((e.currentTarget as HTMLSelectElement).value)} />
      <Select label={s.adminAiProvider} bind:value={providerId} disabled={busy || !!modelEdit}
        options={[{ value: "", label: s.adminAiChoose }, ...settings.providers.map((p) => ({ value: p.id, label: p.name }))]} />
      <TextField label={s.adminAiModelId} size="sm" bind:value={model} disabled={busy || !!modelEdit} />
      <Text tone="muted" size="sm">{s.adminAiPrices}</Text>
      {#each priceFields as field (field)}
        <TextField label={s.adminAiPriceLabels[field]} size="sm" bind:value={prices[field]} inputmode="decimal" disabled={busy} />
      {/each}
      <Button size="sm" disabled={busy || !providerId || !model.trim() || !validPrices} onclick={saveModel}>{s.save}</Button>
      {#if chosenModel}
        {#if chosenModel.deleteProtected}
          <Text tone="muted" size="sm">{s.adminAiProtectedModel}</Text>
        {/if}
        {@render deletionDependencies(modelDependencies)}
        <Button size="sm" variant="danger" disabled={busy || !!chosenModel.deleteProtected || !!modelDependencies.length} onclick={deleteModel}>{s.adminAiDeleteModel}</Button>
      {/if}
    </Stack>
  </details>
  <details>
    <summary>{s.adminAiRoutes}</summary>
    <Stack gap="sm">
      {#each AI_WORKLOADS as workload (workload)}
        {@const current = settings.routes[workload]}
        {@const value = current ? routeKey(current) : ""}
        {@const options = current && !modelOptions.some((option) => option.value === value)
          ? [{ value, label: routeLabel(current) }, ...modelOptions] : modelOptions}
        <div class="route">
          <Select label={s.adminAiWorkloads[workload]} value={draftRoutes[workload] ?? value} disabled={busy}
            options={[{ value: "", label: s.adminAiChoose, disabled: true }, ...options]}
            onchange={(e) => { draftRoutes[workload] = (e.currentTarget as HTMLSelectElement).value; }} />
          <Button size="sm" disabled={busy || !draftRoutes[workload] || draftRoutes[workload] === value} onclick={() => saveRoute(workload)}>{s.save}</Button>
        </div>
      {/each}
    </Stack>
  </details>
{/if}

<style>
  summary { cursor: pointer; }
  .workload-list { margin: 0; padding-inline-start: 1.25em; }
  details > :global(.cf-stack) { margin-block-start: var(--cf-space-2); }
  .route { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: var(--cf-space-2); align-items: end; }
</style>

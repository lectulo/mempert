CREATE TABLE ai_providers (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  sealed_key TEXT
);

CREATE TABLE ai_models (
  provider_id TEXT NOT NULL REFERENCES ai_providers(id),
  model TEXT NOT NULL,
  -- USD per million tokens. OpenRouter supplies its own usage cost.
  prompt REAL NOT NULL CHECK (prompt >= 0),
  completion REAL NOT NULL CHECK (completion >= 0),
  cache_write REAL NOT NULL CHECK (cache_write >= 0),
  cache_read REAL NOT NULL CHECK (cache_read >= 0),
  PRIMARY KEY (provider_id, model)
);

CREATE TABLE ai_routes (
  workload TEXT PRIMARY KEY NOT NULL,
  provider_id TEXT NOT NULL,
  model TEXT NOT NULL,
  FOREIGN KEY (provider_id, model) REFERENCES ai_models(provider_id, model)
);

INSERT INTO ai_providers (id, name, base_url) VALUES
  ('openrouter', 'OpenRouter', 'https://openrouter.ai/api/v1');

INSERT INTO ai_models (provider_id, model, prompt, completion, cache_write, cache_read) VALUES
  ('openrouter', 'openai/gpt-6-luna', 0, 0, 0, 0),
  ('openrouter', 'google/gemini-4-argon', 0, 0, 0, 0),
  ('openrouter', 'google/gemini-3.8-flash', 0, 0, 0, 0),
  ('openrouter', 'deepseek/deepseek-v4.1-flash-1017', 0, 0, 0, 0),
  ('openrouter', 'x-ai/grok-4.7', 0, 0, 0, 0),
  ('openrouter', 'qwen/qwen3.8-omni-flash', 0, 0, 0, 0);

INSERT INTO ai_routes (workload, provider_id, model) VALUES
  ('photo_medium', 'openrouter', 'openai/gpt-6-luna'),
  ('photo_max', 'openrouter', 'google/gemini-4-argon'),
  ('video', 'openrouter', 'google/gemini-3.8-flash'),
  ('search_rewrite', 'openrouter', 'deepseek/deepseek-v4.1-flash-1017'),
  ('search_agent', 'openrouter', 'deepseek/deepseek-v4.1-flash-1017'),
  ('analysis_labels', 'openrouter', 'deepseek/deepseek-v4.1-flash-1017'),
  ('pair_facts', 'openrouter', 'deepseek/deepseek-v4.1-flash-1017'),
  ('analysis_moods', 'openrouter', 'deepseek/deepseek-v4.1-flash-1017'),
  ('pair_moods', 'openrouter', 'deepseek/deepseek-v4.1-flash-1017');

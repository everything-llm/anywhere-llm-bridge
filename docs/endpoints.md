# The internal API, as the bridge's callers meet it

These are AnythingLLM 1.16.2's facts (`docker.io/mintplexlabs/anythingllm:1.16`, server `version` 1.16.2). They come from reading `/app/server/endpoints` in that image and calling each route on a throwaway instance with a password set. Every path below is under `<ANYTHINGLLM_URL>/api`, which is also the path a client sends the bridge (`GET /scheduled-jobs` reaches `/api/scheduled-jobs`). The bridge does the login; a client sends its developer key. These are the routes the toolkit used before it became a bridge, a place to start when choosing `BRIDGE_ALLOW`. Three are not for a client you wouldn't trust with the owner's settings pages: `POST /system/update-env` (any `.env` value, the password among them), `POST /admin/system-preferences` and `/system/api-keys` (every developer key's secret).

## Login

- `POST /request-token {"password"}` returns `{"valid": true, "token": "<JWT>", "message": null}`. A wrong password returns `{"valid": false, "token": null, "message": "[003] Invalid password provided"}`.
  - The password is `AUTH_TOKEN` in AnythingLLM's `.env`.
- A token is valid for 30 days. A request with no token gets `401`.
- With no password set, `validatedRequest` lets every request through, so the bridge sends no token at all.
- Multi-user mode logs in with a username and needs a role for each route. **The bridge does not handle multi-user mode.** The scheduled-job routes refuse multi-user mode anyway (`isSingleUserMode`).

## Agent skills

- `GET /admin/system-preferences-for?labels=default_agent_skills,disabled_agent_skills,imported_agent_skills` returns `{"settings": {...}}`.
  - `default_agent_skills` is the list of opt-in built-ins that are switched on.
  - `disabled_agent_skills` is the list of default-on built-ins that are switched off.
  - `imported_agent_skills` lists the custom skills' `plugin.json` objects (`hubId`, `name`, `active`, ...).
- The default-on built-ins (`utils/agents/defaults.js`, `DEFAULT_SKILLS`) are `rag-memory`, `document-summarizer`, `web-scraping` and `web-browsing`.
- The opt-in built-ins are `create-chart`, `generate-image`, `sql-agent`, `filesystem-agent`, `create-files-agent`, `gmail-agent`, `outlook-agent`, `google-calendar-agent` and `create-scheduled-job`.
- `websocket`, `chat-history`, `request-user-input` and `model-router-cooldown` are internal and can't be switched.
- `POST /admin/system-preferences {"default_agent_skills": "a,b", "disabled_agent_skills": "c"}` returns `{"success": true, "error": null}`.
  - Each list is sent as **comma-separated text**, and `""` empties it.
  - The new value replaces the whole list.
- `POST /experimental/agent-plugins/<hubId>/toggle {"active": bool}` returns the custom skill's updated `plugin.json`.
  - An unknown `hubId` answers `200` with **an empty body**, so an empty reply means no such skill.

## MCP servers

- `GET /mcp-servers/list` returns `{"success": true, "servers": [{name, config, running, tools: [...], error, process}]}`.
- `POST /mcp-servers/toggle {"name"}` stops a server that is running, and starts one that isn't. It returns `{"success", "error"}`.
  - Toggling is **not persisted**. A server comes back on after a reload or a restart, unless its config sets `anythingllm.autoStart: false`.
  - An unknown name returns `{"success": false, "error": "MCP server <name> not found in config file."}`.
  - Starting a server that never answers returns `{"success": false, "error": "Connection timeout"}`, but only after about 30 s.
- Listing, both `GET /mcp-servers/list` and `GET /scheduled-jobs/available-tools` (which holds each server's tools), tries to start every configured server that isn't running. So one server that never answers makes each list take **about 30 s**.
- `GET /mcp-servers/force-reload` returns `{"success", "error", "servers"}`. It restarts every server and waits for each one, so it **can take minutes**.

## Saved memories

- When memories are off (`memory_enabled` is `"false"`, the default), every memory route returns `403 {"error": "Personalization is disabled."}`. They can be turned on with `POST /admin/system-preferences {"memory_enabled": "true"}`.
- `GET /workspaces/<slug>/memories` returns `{"memories": {"global": [...], "workspace": [...]}}`. Each memory is `{id, userId, workspaceId, scope, content, lastUsedAt, createdAt, updatedAt}`.
- `POST /workspaces/<slug>/memories {"content", "scope": "global"|"workspace"}` returns `{"memory": {...}}`. The scope defaults to `workspace`. A refusal returns `400 {"error"}`.
- `PUT /memories/<id> {"content"}` returns `{"memory"}`.
- `POST /memories/<id>/promote` makes a memory global, and `POST /memories/<id>/demote/<slug>` makes it that workspace's. Each returns `{"memory"}`.
- `DELETE /memories/<id>` returns `{"success": true}`. An unknown id returns `404 {"error": "Memory not found."}`.
- `GET /admin/system-preferences-for?labels=memory_enabled,memory_auto_extraction` returns `{"settings"}` with each as text. `memory_auto_extraction` is on unless it is `"false"`. `POST /admin/system-preferences` sets either the same way.

## Scheduled jobs (single-user mode only)

- `GET /scheduled-jobs` returns `{"jobs": [{id, name, prompt, tools, schedule, enabled, lastRunAt, nextRunAt, createdAt, updatedAt, latestRun}]}`.
  - `tools` is **JSON text** (`"[\"web-scraping\"]"`) or null.
  - `schedule` is a cron expression in UTC.
- `GET /scheduled-jobs/<id>` returns `{"job"}`. An unknown id returns `404 {"job": null, "error": "Job not found"}`.
- `GET /scheduled-jobs/<id>/runs` returns `{"runs": [...]}`: the newest 50, each `{id, jobId, status, result, error, startedAt, completedAt, readAt}`.
  - `status` is one of `queued`, `running`, `completed`, `failed` or `timed_out`.
  - `result` holds a long JSON trace.
- `GET /scheduled-jobs/available-tools` returns `{"tools": [{category, name, items: [{id, name, description, requiresSetup?}]}]}`. A sub-skill's id looks like `filesystem-agent#filesystem-read-text-file`.
- `POST /scheduled-jobs/new {name, prompt, tools, schedule}` returns `201 {"job", "error": null}`.
  - A refusal returns `400 {"job": null, "error"}`, with errors such as "Invalid cron expression" or the active-jobs cap.
- `PUT /scheduled-jobs/<id> {"enabled": false}` returns `{"job", "error": null}`.
- `DELETE /scheduled-jobs/<id>` returns `{"success": bool}`. An unknown id gives `false`, not a 404.

## Chats (threads)

A chat is a thread. The slug in the path is the workspace's, and `<thread>` is the thread's `slug` (a UUID), not its `id`. An unknown workspace or thread answers `404` with a plain-text message (`Workspace does not exist.`, `Workspace thread does not exist.`), which the bridge returns as `null`.

- `GET /workspace/<slug>/threads` returns `{"threads": [{id, name, slug, workspace_id, user_id, createdAt, lastUpdatedAt}], "defaultThreadChatCount"}`.
- `POST /workspace/<slug>/thread/new` returns `{"thread", "message"}`. The thread is named `Thread` until it is renamed.
- `POST /workspace/<slug>/thread/<thread>/update {"name"}` returns `{"thread", "message"}`. `name` is the only field it takes; a body with no other field answers `200` with `"message": "No valid fields to update!"` and changes nothing.
- `GET /workspace/<slug>/thread/<thread>/chats` returns `{"history": [...]}`, oldest first: a user message and then its answer for each exchange, both with the exchange's `chatId`, plus `role`, `content` and `sentAt`.
- `DELETE /workspace/<slug>/thread/<thread>` deletes the thread and its chats. It answers `200` with the body `OK`, which is not JSON, so the bridge returns `null`.
- `DELETE /workspace/<slug>/thread/<thread>/delete-edited-chats {"startingId"}` deletes the thread's exchanges whose `chatId` is at least `startingId`. With the oldest exchange's `chatId` it clears the thread and keeps the thread. It answers `200` with `OK`.
- Left out of the chat rules on purpose: `DELETE /workspace/<slug>` and `/update`, `reset-vector-db`, `delete-chats` (any exchange of the workspace by id), `thread-bulk-delete`, `thread/fork` and the stream routes.

## Developer keys

- `GET /system/api-keys` returns `{"apiKeys": [{id, name, secret, ...}]}`.
- `POST /system/generate-api-key {"name"}` returns `{"apiKey": {name, secret, ...}, "error"}`.

## Models

- `GET /setup-complete` returns `{"results": {...}}`.
  - `LLMProvider` and `LLMModel` are the system's provider and its model.
  - The provider's own `<X>ModelPref` key is also present.
  - No login is needed.
- `POST /system/custom-models {"provider"}` returns `{"models": [{id, ...}], "error"}`.
  - An unsupported provider returns `{"models": [], "error": "Invalid provider for custom models"}`.
  - An unreachable provider returns an empty list.
- `POST /system/update-env {"LLMProvider", "<X>ModelPref"}` returns `{"newValues", "error": false}`. An unknown provider returns `{"newValues": {}, "error": "<p> is not a valid LLM provider."}`.
  - Each provider's model key is the `updateENV` key whose env var `getBaseLLMProviderModel` reads. For example, `ollama` uses `OllamaLLMModelPref` and `anthropic` uses `AnthropicModelPref`.
- `GET /workspaces` returns `{"workspaces": [...]}`. Each workspace has `slug`, `name`, `chatProvider`, `chatModel`, `agentProvider` and `agentModel`, and a null means the workspace follows the system's setting.
- `POST /workspace/<slug>/update {"chatProvider", "chatModel"}` (or the `agent` pair) returns `{"workspace", "message"}`.
  - A null, `""`, or a provider of `"none"` stores null.
  - An unknown slug returns `400`.

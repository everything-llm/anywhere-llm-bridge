// What the chat tools do. A chat is one of AnythingLLM's threads, named by its slug inside a
// workspace's slug. A change that loses something (clear, delete) is shown first and made only with
// `apply`, and is read back afterwards, since AnythingLLM answers a delete with a bare OK.

import { bounded, ControlError, items, obj, slug, text, type Anything, type Obj } from "./anything.mts";

export const CHAT_NAME_MAX = 100;
export const SHOWN = 600; // characters of a message in a history
export const HISTORY = 10; // exchanges a history shows unless it is asked for more
export const HISTORY_MAX = 50;

/** A question and its answer, which AnythingLLM numbers together as one `chatId`. */
export interface Exchange {
  chatId: number;
  question: string;
  answer: string;
}

/** The exchanges in a thread's `history`, oldest first: it lists a user message and an assistant
 *  message for each, both with the exchange's `chatId`. */
export function exchangesOf(history: unknown): Exchange[] {
  const found = new Map<number, Record<string, string>>();
  for (const entry of items(history).map(obj)) {
    const id = entry.chatId;
    if (!Number.isInteger(id)) continue;
    const messages = found.get(id as number) ?? {};
    messages[text(entry.role)] = text(entry.content);
    found.set(id as number, messages);
  }
  return [...found].map(([chatId, m]) => ({ chatId, question: m.user ?? "", answer: m.assistant ?? "" }));
}

const clipped = (message: string): string => (message.length <= SHOWN ? message : `${message.slice(0, SHOWN)}... (cut)`);

const base = (workspace: string): string => `/workspace/${slug(workspace, "workspace")}`;
const pathOf = (workspace: string, chat: string): string => `${base(workspace)}/thread/${slug(chat, "chat")}`;

export class Chats {
  readonly #api: Anything;

  constructor(api: Anything) {
    this.#api = api;
  }

  async workspaces(): Promise<Obj> {
    const reply = obj(await this.#api.call("GET", "/workspaces"));
    return { workspaces: items(reply.workspaces).map(obj).map((w) => ({ workspace: text(w.slug), name: text(w.name) })) };
  }

  async listing(workspace: string): Promise<Obj> {
    const threads = await this.#threads(workspace);
    return { workspace, chats: threads.map((t) => ({ chat: text(t.slug), name: text(t.name), updated: t.lastUpdatedAt ?? null })) };
  }

  async history(workspace: string, chat: string, last: number): Promise<Obj> {
    if (!(last >= 1 && last <= HISTORY_MAX)) throw new ControlError(`last is from 1 to ${HISTORY_MAX}; got ${last}`);
    const [shown, found] = await this.#summary(workspace, chat);
    return { ...shown, shown: found.slice(-last).map((e) => ({ chatId: e.chatId, question: clipped(e.question), answer: clipped(e.answer) })) };
  }

  async new(workspace: string): Promise<Obj> {
    const reply = obj(await this.#api.call("POST", `${base(workspace)}/thread/new`));
    const thread = obj(reply.thread);
    if (!Object.keys(thread).length) throw new ControlError(text(reply.message) || "no chat was made");
    return { chat: text(thread.slug), name: text(thread.name) };
  }

  async rename(workspace: string, chat: string, name: string): Promise<Obj> {
    const wanted = bounded(name, "a chat's name", CHAT_NAME_MAX);
    await this.#thread(workspace, chat);
    const reply = obj(await this.#api.call("POST", `${pathOf(workspace, chat)}/update`, { name: wanted }));
    if (text(obj(reply.thread).name) !== wanted) throw new ControlError(text(reply.message) || "the chat was not renamed");
    return { chat, name: wanted };
  }

  /** Removes every exchange and keeps the chat and its name. */
  async clear(workspace: string, chat: string, apply: boolean): Promise<Obj> {
    const [shown, found] = await this.#summary(workspace, chat);
    if (!found.length) return { ...shown, applied: false, note: "the chat is already empty" };
    if (!apply) return { ...shown, applied: false, would: "remove every exchange, keep the chat" };
    await this.#api.call("DELETE", `${pathOf(workspace, chat)}/delete-edited-chats`, { startingId: found[0].chatId });
    const left = await this.#history(workspace, chat);
    if (left.length) throw new ControlError(`${left.length} of ${found.length} exchanges are still there`);
    return { ...shown, applied: true, removed: found.length };
  }

  /** Removes the chat and its exchanges. */
  async delete(workspace: string, chat: string, apply: boolean): Promise<Obj> {
    const [shown] = await this.#summary(workspace, chat);
    if (!apply) return { ...shown, applied: false, would: "delete the chat and its exchanges" };
    await this.#api.call("DELETE", pathOf(workspace, chat));
    if ((await this.#threads(workspace)).some((t) => text(t.slug) === chat)) throw new ControlError("the chat is still there");
    return { ...shown, applied: true, deleted: true };
  }

  async #threads(workspace: string): Promise<Obj[]> {
    return items(obj(await this.#api.call("GET", `${base(workspace)}/threads`)).threads).map(obj);
  }

  /** What a change is shown as, and the chat's exchanges, oldest first. */
  async #summary(workspace: string, chat: string): Promise<[Obj, Exchange[]]> {
    const thread = await this.#thread(workspace, chat);
    const found = await this.#history(workspace, chat);
    return [{ chat, name: text(thread.name), exchanges: found.length }, found];
  }

  async #thread(workspace: string, chat: string): Promise<Obj> {
    slug(chat, "chat"); // before any call: a bad slug never reaches AnythingLLM
    const thread = (await this.#threads(workspace)).find((t) => text(t.slug) === chat);
    if (!thread) throw new ControlError(`workspace ${JSON.stringify(workspace)} has no chat ${JSON.stringify(chat)}`);
    return thread;
  }

  async #history(workspace: string, chat: string): Promise<Exchange[]> {
    return exchangesOf(obj(await this.#api.call("GET", `${pathOf(workspace, chat)}/chats`)).history);
  }
}

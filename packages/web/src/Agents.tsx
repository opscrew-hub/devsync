import {
  type Agent,
  type AgentKind,
  AgentMessage,
  AgentMessageReceipt,
  LIMITS,
  SignalKind,
} from "@devsync/schemas";
import { type FormEvent, useId, useState } from "react";
import styles from "./devsync.module.css";
import { DialogButtons, Field, formatTime, Problem } from "./parts";
import { type DevSyncIcon, useDevSync } from "./provider";
import { useAgents, useChange } from "./queries";

const KIND: Record<AgentKind, string> = {
  CLAUDE: "Claude Code",
  CODEX: "Codex",
  OTHER: "Other agent",
};

const STATUS: Record<Agent["status"], [string, DevSyncIcon]> = {
  "Recently active": ["s-good", "check-circle"],
  Offline: ["s-muted", "clock-counter-clockwise"],
  Expired: ["s-warning", "warning"],
  Revoked: ["s-muted", "trash"],
};

const MESSAGE_KIND: Record<SignalKind, string> = {
  "clarification.requested": "Clarification requested",
  "clarification.answered": "Clarification answered",
  "review.requested": "Review requested",
  "system.warning": "Warning",
};

/** Where agents are managed: the host's Agents button, on the project's page. */
const AGENTS_BUTTON = "the Agents button at the top of this project's page";

/** What an agent's line says of it: when it was last seen, and when DevSync's own token ends. */
function seen(agent: Agent): string {
  if (agent.createdAt === null) {
    return "Not connected yet: it can get messages once it has connected to DevSync";
  }
  const last = agent.lastSeenAt ? `Last seen ${formatTime(agent.lastSeenAt)}` : "Not connected yet";
  return agent.expiresAt && agent.status !== "Revoked"
    ? `${last} · token valid until ${formatTime(agent.expiresAt)}`
    : last;
}

/**
 * The agents that may reach the project's DevSync, which anyone may write to. The host registers
 * them and rotates and revokes their tokens, from its Agents button.
 */
export function Agents({ className }: { className?: string }) {
  const { ui, may } = useDevSync();
  const { Icon, EmptyState } = ui;
  const agents = useAgents();
  const [messaging, setMessaging] = useState<Agent | null>(null);
  const heading = useId();
  const list = agents.data?.agents ?? [];

  return (
    <section className={`card bordered ${className ?? ""}`} aria-labelledby={heading}>
      <div className="card-h">
        <h3 className="card-t" id={heading}>
          <Icon name="robot" />
          Agents
        </h3>
      </div>
      <p className="sub">
        Agents are registered, and their tokens rotated and revoked, from {AGENTS_BUTTON}.
      </p>
      <Problem error={agents.error} />
      {agents.isSuccess && list.length === 0 && (
        <EmptyState icon="robot" title="No agents yet">
          Register Claude Code or Codex with {AGENTS_BUTTON} to let it claim this project's Ready
          tasks through MCP.
        </EmptyState>
      )}
      {list.length > 0 && (
        <ul className="feed" aria-label="Agents">
          {list.map((agent) => {
            const [tone, icon] = STATUS[agent.status];
            const reachable =
              agent.createdAt !== null && agent.status !== "Revoked" && agent.status !== "Expired";
            return (
              <li key={agent.id}>
                <Icon name="robot" />
                <div className={styles.stack}>
                  <p className={styles.inline}>
                    <span className="cream">{agent.name}</span>
                    <span className="chip">{KIND[agent.kind]}</span>
                    <span className={`status ${tone}`}>
                      <Icon name={icon} className="i-sm" />
                      {agent.status}
                    </span>
                  </p>
                  <p className="sub">{seen(agent)}</p>
                  <fieldset className={styles.buttons} aria-label={agent.name}>
                    <button
                      className="btn btn-sm btn-secondary bordered"
                      type="button"
                      disabled={!may("task.write") || !reachable}
                      onClick={() => setMessaging(agent)}
                    >
                      <Icon name="paper-plane-tilt" className="i-sm" />
                      Send a message
                    </button>
                  </fieldset>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {messaging && <Message agent={messaging} onClose={() => setMessaging(null)} />}
    </section>
  );
}

function Message({ agent, onClose }: { agent: Agent; onClose: () => void }) {
  const { Dialog } = useDevSync().ui;
  // One key per dialog: sending again after a lost answer reaches the agent once.
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const send = useChange(AgentMessage, (api, body) =>
    api.send("POST", `/agents/${agent.id}/messages`, body, AgentMessageReceipt),
  );

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    send.mutate(
      { kind: form.get("kind"), message: form.get("message"), idempotencyKey },
      { onSuccess: onClose },
    );
  }

  return (
    <Dialog title={`Message ${agent.name}`} icon="paper-plane-tilt" onSubmit={submit}>
      <div className={styles.form}>
        <Field label="Kind">
          <select className="field" name="kind" defaultValue="clarification.answered">
            {SignalKind.options.map((kind) => (
              <option key={kind} value={kind}>
                {MESSAGE_KIND[kind]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Message">
          <textarea className="field" name="message" rows={4} required maxLength={LIMITS.message} />
        </Field>
      </div>
      <p className="sub">It reaches the agent's inbox once, the next time it checks.</p>
      <Problem error={send.error} />
      <DialogButtons label="Send" pending={send.isPending} onCancel={onClose} />
    </Dialog>
  );
}

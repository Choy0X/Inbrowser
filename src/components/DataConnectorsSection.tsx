import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import {
  loadDataConnectors,
  saveDataConnectors,
  newDataConnector,
  type DataConnector,
} from "../lib/dataConnectors";
import { Section, Field, Input, IconButton, Button } from "./ui";

/**
 * Configuration for the http_request tool (lib/tools/dataConnectorTools.ts).
 * Lives here rather than under any one agent - a connector is a workspace-
 * wide resource any agent with that tool enabled can reach, not per-agent
 * config. Auth values are entered here and never leave this page: they are
 * not part of agent export/import (see agents.ts's serializeAgents).
 */
export function DataConnectorsSection() {
  const [connectors, setConnectors] = useState<DataConnector[]>(() => loadDataConnectors());

  const persist = (next: DataConnector[]) => {
    setConnectors(next);
    saveDataConnectors(next);
  };

  const add = () => persist([...connectors, newDataConnector()]);
  const update = (id: string, patch: Partial<DataConnector>) =>
    persist(connectors.map((c) => (c.id === id ? { ...c, ...patch, updatedAt: Date.now() } : c)));
  const remove = (id: string) => persist(connectors.filter((c) => c.id !== id));

  return (
    <Section
      title="Data connectors"
      description="REST/JSON APIs the http_request tool can call. Only reaches APIs that send CORS headers for this app's origin - most enterprise databases, including Snowflake's own REST endpoints, do not. Keys entered here stay on this page; they are never included in agent export."
      actions={<Button size="sm" icon={<Plus size={13} />} onClick={add}>Add connector</Button>}
    >
      {connectors.length === 0 ? (
        <p className="text-xs text-fg-faint">No connectors configured.</p>
      ) : (
        <div className="space-y-3">
          {connectors.map((c) => (
            <div key={c.id} className="rounded-lg border border-border-subtle bg-bg-elevated p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="grid min-w-0 flex-1 gap-2 sm:grid-cols-2">
                  <Field label="Name">
                    <Input value={c.name} onChange={(e) => update(c.id, { name: e.target.value })} />
                  </Field>
                  <Field label="Base URL">
                    <Input
                      value={c.baseUrl}
                      onChange={(e) => update(c.id, { baseUrl: e.target.value })}
                      placeholder="https://api.example.com"
                    />
                  </Field>
                  <Field label="Auth header name" hint="e.g. Authorization">
                    <Input value={c.authHeaderName ?? ""} onChange={(e) => update(c.id, { authHeaderName: e.target.value })} />
                  </Field>
                  <Field label="Auth header value" hint="e.g. Bearer sk-...">
                    <Input
                      type="password"
                      value={c.authHeaderValue ?? ""}
                      onChange={(e) => update(c.id, { authHeaderValue: e.target.value })}
                    />
                  </Field>
                  <Field label="Description" className="sm:col-span-2">
                    <Input value={c.description} onChange={(e) => update(c.id, { description: e.target.value })} placeholder="What this connector is for" />
                  </Field>
                </div>
                <IconButton label="Delete connector" icon={<Trash2 size={14} />} size="sm" className="hover:text-error" onClick={() => remove(c.id)} />
              </div>
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}

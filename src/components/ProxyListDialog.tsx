import { useMemo, useRef, useState } from "react";
import type { CustomProxy, ProxyProtocol } from "../lib/types";
import { PROXY_PROTOCOLS } from "../lib/types";
import { proxyKey } from "../lib/gateway/freeProxyList";
import { inspectProxyList, serializeProxyList, type ProxyExportFormat } from "../lib/gateway/proxyListIO";
import { Dialog } from "./Dialog";
import { Button, Select, Textarea } from "./ui";

export function ProxyListDialog({ mode, proxies, onImport, onClose }: {
  mode: "import" | "export";
  proxies: CustomProxy[];
  onImport: (proxies: CustomProxy[]) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const [protocol, setProtocol] = useState<ProxyProtocol>("http");
  const [format, setFormat] = useState<ProxyExportFormat>("urls");
  const [fileError, setFileError] = useState("");
  const [reading, setReading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const preview = useMemo(() => {
    try {
      const result = inspectProxyList(text, protocol);
      const seen = new Set(proxies.map(proxyKey));
      const incoming = result.proxies.filter(proxy => {
        const key = proxyKey(proxy);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      return { ...result, incoming, duplicates: result.proxies.length - incoming.length, error: "" };
    } catch (error) {
      return { proxies: [], incoming: [], invalidRows: [], duplicates: 0, error: (error as Error).message };
    }
  }, [text, protocol, proxies]);

  const download = () => {
    const blob = new Blob([serializeProxyList(proxies, format)], { type: format === "json" ? "application/json" : "text/plain" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `inbrowser-proxies-${new Date().toISOString().slice(0, 10)}.${format === "json" ? "json" : "txt"}`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    onClose();
  };
  return <Dialog open onClose={onClose} title={mode === "import" ? "Import proxies" : "Export proxies"} size="xl">
    <div className="space-y-4">
      {mode === "import" ? <>
        <p className="text-sm text-fg-dim">Paste one proxy per line, or choose a text or JSON file. IP addresses, hostnames, usernames and passwords are preserved.</p>
        <div className="flex flex-wrap items-end gap-3">
          <label className="min-w-48 flex-1 text-xs text-fg-dim">Protocol for entries without a scheme
            <Select className="mt-1" value={protocol} onChange={e => setProtocol(e.target.value as ProxyProtocol)}>
              {PROXY_PROTOCOLS.map(p => <option key={p} value={p}>{p.toUpperCase()}</option>)}
            </Select>
          </label>
          <Button onClick={() => inputRef.current?.click()} loading={reading}>Choose file</Button>
          <input ref={inputRef} type="file" accept=".txt,.json,.list,text/plain,application/json" className="hidden" onChange={async e => {
            const file = e.target.files?.[0]; e.target.value = "";
            if (!file) return;
            setFileError(""); setReading(true);
            try { setText(await file.text()); } catch { setFileError("Could not read that file."); }
            finally { setReading(false); }
          }} />
        </div>
        <label className="block text-xs text-fg-dim">Proxy list
          <Textarea className="mt-1 font-mono text-xs" rows={7} value={text} spellCheck={false} autoComplete="off" onChange={e => setText(e.target.value)} placeholder={"host:port\nhost:port:username:password\nsocks5://username:password@host:port"} />
        </label>
        <div aria-live="polite" className="space-y-1 text-xs text-fg-dim">
          {text.trim() && <p>{preview.incoming.length} ready to import. {preview.duplicates} duplicates skipped.</p>}
          {preview.invalidRows.length > 0 && <p className="text-warning">{preview.invalidRows.length} invalid entries will be skipped (rows {preview.invalidRows.slice(0, 12).join(", ")}{preview.invalidRows.length > 12 ? ", ..." : ""}).</p>}
          {(fileError || preview.error) && <p className="text-error">{fileError || preview.error}</p>}
        </div>
        <p className="text-xs text-fg-faint">Select SOCKS5 if your list has no protocol and uses SOCKS5. Imports keep existing proxies. Save Settings to keep your changes.</p>
        <div className="flex justify-end gap-2"><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={reading || !preview.incoming.length} onClick={() => { onImport(preview.incoming); onClose(); }}>Import {preview.incoming.length || ""} proxies</Button></div>
      </> : <>
        <p className="text-sm text-fg-dim">Export {proxies.length} {proxies.length === 1 ? "proxy" : "proxies"}, including their addresses and authentication.</p>
        <label className="block text-xs text-fg-dim">File format
          <Select className="mt-1" value={format} onChange={e => setFormat(e.target.value as ProxyExportFormat)}>
            <option value="urls">Text - protocol://username:password@host:port</option>
            <option value="json">JSON - includes labels and enabled state</option>
          </Select>
        </label>
        <p className="rounded-lg border border-warning/30 bg-warning/10 p-3 text-xs leading-5 text-warning">This file includes proxy usernames and passwords in plain text. Keep it private.</p>
        <div className="flex justify-end gap-2"><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={download}>Download</Button></div>
      </>}
    </div>
  </Dialog>;
}

import { useState } from "react";
import { Check, Eye, EyeOff } from "lucide-react";

export function SystemSection() {
  const [secret, setSecret] = useState(
    () => localStorage.getItem("adminSecret") ?? ""
  );
  const [show, setShow] = useState(false);
  const [saved, setSaved] = useState(false);

  function handleSave() {
    if (secret.trim()) {
      localStorage.setItem("adminSecret", secret.trim());
    } else {
      localStorage.removeItem("adminSecret");
    }
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  return (
    <div className="space-y-6 max-w-lg">
      <div>
        <h2 className="text-sm font-medium text-stone-300 mb-1">Admin Secret</h2>
        <p className="text-xs text-stone-500 mb-3">
          Enter the <code className="text-teal-400">NOVA_ADMIN_SECRET</code> value
          from your <code className="text-teal-400">.env</code> file. Required to
          connect to Nova.
        </p>
        <div className="flex gap-2">
          <div className="relative flex-1">
            <input
              type={show ? "text" : "password"}
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSave()}
              placeholder="nova-dev-secret"
              className="w-full bg-stone-800 border border-stone-700 rounded-lg px-3 py-2 pr-9 text-sm outline-none focus:border-teal-600 placeholder:text-stone-600"
            />
            <button
              type="button"
              onClick={() => setShow((v) => !v)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-stone-500 hover:text-stone-300"
            >
              {show ? <EyeOff size={15} /> : <Eye size={15} />}
            </button>
          </div>
          <button
            onClick={handleSave}
            className="flex items-center gap-1.5 px-3 py-2 text-sm bg-teal-700 hover:bg-teal-600 rounded-lg transition-colors"
          >
            {saved ? <Check size={14} /> : null}
            {saved ? "Saved" : "Save"}
          </button>
        </div>
        {!localStorage.getItem("adminSecret") && (
          <p className="mt-2 text-xs text-amber-500">
            No admin secret set — chat connection will fail until you save one.
          </p>
        )}
      </div>
    </div>
  );
}

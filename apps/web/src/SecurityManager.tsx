import { useEffect, useState } from "react";
import Field from "./Field";

type Channel = { id: string; name: string; type: number; parent_id: string | null };

export type SecurityConfig = {
  log_channel_id: string | null;
  anti_spam_enabled: number;
  anti_spam_threshold: number;
  anti_spam_window_ms: number;
  anti_link_enabled: number;
  anti_link_whitelist: string;
  raid_protection_enabled: number;
  raid_join_threshold: number;
  raid_window_ms: number;
  raid_action: string;
};

// Toggle ported verbatim from xaccount-bot's apps/web/src/SecurityManager.tsx (lines 142-172).
function Toggle({
  value,
  onChange,
  title,
  description,
  disabled = false
}: {
  value: boolean;
  onChange: (value: boolean) => void;
  title: string;
  description: string;
  disabled?: boolean;
}) {
  return (
    <label className={`toggle-row ${disabled ? "disabled" : ""}`}>
      <span className="toggle-copy">
        <strong>{title}</strong>
        <small>{description}</small>
      </span>
      <span className={`switch ${value ? "on" : ""}`}>
        <input type="checkbox" checked={value} disabled={disabled} onChange={event => onChange(event.target.checked)} />
        <span />
      </span>
    </label>
  );
}

// NOTE: xaccount-bot's real SecurityManager.tsx drives a full security-bot subsystem —
// anti-nuke/anti-raid/anti-phishing/webhook-guard/role-guard/permission-guard module toggles,
// balanced/strict/paranoid threshold presets, an incident log and a lockdown system, all
// backed by its own /api/guilds/:id/security-center endpoint. None of that exists in
// cc-server's Worker; cc-server only has three boolean toggles (anti_spam, anti_link,
// raid_protection) plus their numeric thresholds in guild_config, and a single log channel.
// The Toggle component above is reused verbatim since it's a true 1:1 match; the surrounding
// layout (card > section-head > toggle-stack, Field-wrapped numeric/select inputs) mirrors
// the same conventions xaccount-bot's file uses for its own settings.
export default function SecurityManager({
  channels,
  config,
  onSave
}: {
  channels: Channel[];
  config: SecurityConfig;
  onSave: (patch: Partial<SecurityConfig>) => void;
}) {
  const [draft, setDraft] = useState(config);
  useEffect(() => setDraft(config), [config]);

  const logChannels = channels.filter(c => c.type === 0 || c.type === 5);

  return (
    <section className="card" style={{ padding: 24 }}>
      <div className="section-head">
        <div>
          <span className="eyebrow">SECURITY</span>
          <h2>セキュリティ</h2>
        </div>
        <button type="button" className="secondary" onClick={() => onSave(draft)}>
          セキュリティ設定を保存
        </button>
      </div>

      <Field label="ログチャンネル" hint="モデレーション関連のログを送信するチャンネルです">
        <select value={draft.log_channel_id ?? ""} onChange={e => setDraft({ ...draft, log_channel_id: e.target.value || null })}>
          <option value="">チャンネルを選択</option>
          {logChannels.map(channel => (
            <option key={channel.id} value={channel.id}>
              #{channel.name}
            </option>
          ))}
        </select>
      </Field>

      <div className="toggle-stack">
        <Toggle
          title="Anti-Spam"
          description="短時間の連投を検知します"
          value={Boolean(draft.anti_spam_enabled)}
          onChange={value => setDraft({ ...draft, anti_spam_enabled: value ? 1 : 0 })}
        />
        {Boolean(draft.anti_spam_enabled) && (
          <div className="form-grid two">
            <Field label="連投とみなす件数">
              <input
                type="number"
                min={1}
                max={50}
                value={draft.anti_spam_threshold}
                onChange={e => setDraft({ ...draft, anti_spam_threshold: Number(e.target.value) })}
              />
            </Field>
            <Field label="ウィンドウ（ms）">
              <input
                type="number"
                min={1000}
                max={60000}
                value={draft.anti_spam_window_ms}
                onChange={e => setDraft({ ...draft, anti_spam_window_ms: Number(e.target.value) })}
              />
            </Field>
          </div>
        )}

        <Toggle
          title="Anti-Link"
          description="不審なリンクの投稿を検知します"
          value={Boolean(draft.anti_link_enabled)}
          onChange={value => setDraft({ ...draft, anti_link_enabled: value ? 1 : 0 })}
        />
        {Boolean(draft.anti_link_enabled) && (
          <Field label="ホワイトリスト（JSON配列）" hint='例: ["example.com"]'>
            <input value={draft.anti_link_whitelist} onChange={e => setDraft({ ...draft, anti_link_whitelist: e.target.value })} />
          </Field>
        )}

        <Toggle
          title="Raid Protection"
          description="短時間の大量参加を検知します"
          value={Boolean(draft.raid_protection_enabled)}
          onChange={value => setDraft({ ...draft, raid_protection_enabled: value ? 1 : 0 })}
        />
        {Boolean(draft.raid_protection_enabled) && (
          <div className="form-grid three">
            <Field label="参加人数の閾値">
              <input
                type="number"
                min={2}
                max={100}
                value={draft.raid_join_threshold}
                onChange={e => setDraft({ ...draft, raid_join_threshold: Number(e.target.value) })}
              />
            </Field>
            <Field label="ウィンドウ（ms）">
              <input
                type="number"
                min={1000}
                max={60000}
                value={draft.raid_window_ms}
                onChange={e => setDraft({ ...draft, raid_window_ms: Number(e.target.value) })}
              />
            </Field>
            <Field label="アクション">
              <select value={draft.raid_action} onChange={e => setDraft({ ...draft, raid_action: e.target.value })}>
                <option value="lock">lock</option>
                <option value="kick">kick</option>
                <option value="ban">ban</option>
              </select>
            </Field>
          </div>
        )}
      </div>
    </section>
  );
}

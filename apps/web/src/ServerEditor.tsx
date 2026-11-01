import { useEffect, useState } from "react";
import Field from "./Field";

type Channel = { id: string; name: string; type: number; parent_id: string | null };
type Role = { id: string; name: string; color: number };
type Meta = { id: string; name: string; icon: string | null; channels: Channel[]; roles: Role[] };

export type ServerConfig = {
  admin_role_id: string | null;
  mod_role_id: string | null;
  verified_role_id: string | null;
  verify_channel_id: string | null;
  welcome_channel_id: string | null;
  welcome_message: string | null;
  leave_channel_id: string | null;
  leave_message: string | null;
};

// NOTE: xaccount-bot's own ServerEditor (apps/web/src/ServerEditor/index.tsx) is a
// Discord channel-tree / permission-overwrite builder (channel creation, drag-to-reorder,
// per-role permission matrices) — cc-server's Worker has no matching endpoints for any of
// that, so none of it applies here. What DOES carry over 1:1 is xaccount-bot's role/channel
// settings idiom used for its verification section (App.tsx, the "VERIFICATION" card around
// line 1120: section-head + save button, form-grid of Field-wrapped selects). That pattern is
// reused here for every role/channel field cc-server's guild_config actually has.
export default function ServerEditor({
  meta,
  config,
  onSave
}: {
  meta: Meta;
  config: ServerConfig;
  onSave: (patch: Partial<ServerConfig>) => void;
}) {
  const [draft, setDraft] = useState(config);
  useEffect(() => setDraft(config), [config]);

  const textChannels = meta.channels.filter(c => c.type === 0 || c.type === 5);

  return (
    <section className="card" style={{ padding: 24 }}>
      <div className="section-head">
        <div>
          <span className="eyebrow">SERVER</span>
          <h2>サーバー設定</h2>
        </div>
        <button type="button" className="secondary" onClick={() => onSave(draft)}>
          サーバー設定を保存
        </button>
      </div>

      <div className="form-grid two">
        <Field label="管理者ロール">
          <select value={draft.admin_role_id ?? ""} onChange={e => setDraft({ ...draft, admin_role_id: e.target.value || null })}>
            <option value="">ロールを選択</option>
            {meta.roles.map(role => (
              <option key={role.id} value={role.id}>
                @{role.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="モデレーターロール">
          <select value={draft.mod_role_id ?? ""} onChange={e => setDraft({ ...draft, mod_role_id: e.target.value || null })}>
            <option value="">ロールを選択</option>
            {meta.roles.map(role => (
              <option key={role.id} value={role.id}>
                @{role.name}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <div className="form-grid two">
        <Field label="認証後ロール">
          <select value={draft.verified_role_id ?? ""} onChange={e => setDraft({ ...draft, verified_role_id: e.target.value || null })}>
            <option value="">ロールを選択</option>
            {meta.roles.map(role => (
              <option key={role.id} value={role.id}>
                @{role.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="認証チャンネル" hint="テキスト / アナウンスチャンネルに設置できます">
          <select value={draft.verify_channel_id ?? ""} onChange={e => setDraft({ ...draft, verify_channel_id: e.target.value || null })}>
            <option value="">チャンネルを選択</option>
            {textChannels.map(channel => (
              <option key={channel.id} value={channel.id}>
                #{channel.name}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <div className="form-grid two">
        <Field label="入室メッセージ送信先">
          <select value={draft.welcome_channel_id ?? ""} onChange={e => setDraft({ ...draft, welcome_channel_id: e.target.value || null })}>
            <option value="">チャンネルを選択</option>
            {textChannels.map(channel => (
              <option key={channel.id} value={channel.id}>
                #{channel.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="退室メッセージ送信先">
          <select value={draft.leave_channel_id ?? ""} onChange={e => setDraft({ ...draft, leave_channel_id: e.target.value || null })}>
            <option value="">チャンネルを選択</option>
            {textChannels.map(channel => (
              <option key={channel.id} value={channel.id}>
                #{channel.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="入室メッセージ" hint="{user} でメンションに置き換わります">
          <input value={draft.welcome_message ?? ""} onChange={e => setDraft({ ...draft, welcome_message: e.target.value })} />
        </Field>
        <Field label="退室メッセージ" hint="{user} でメンションに置き換わります">
          <input value={draft.leave_message ?? ""} onChange={e => setDraft({ ...draft, leave_message: e.target.value })} />
        </Field>
      </div>
    </section>
  );
}

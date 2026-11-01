import { useState } from "react";

type Channel = { id: string; name: string; type: number; parent_id: string | null };
type Role = { id: string; name: string; color: number };
type Meta = { id: string; name: string; icon: string | null; channels: Channel[]; roles: Role[] };

export type Panel = { id: number; title: string; description: string | null; message_id: string | null; channel_id: string | null };
export type PanelButton = { id: number; label: string; style: string; emoji: string | null; action_type: string; action_value: string };

const STYLE_LABEL: Record<string, string> = { Primary: "青", Secondary: "グレー", Success: "緑", Danger: "赤" };

export default function Panels({
  meta,
  panels,
  panelButtons,
  onCreatePanel,
  onAddButton,
  onDeleteButton,
  onPostPanel
}: {
  meta: Meta;
  panels: Panel[];
  panelButtons: Record<number, PanelButton[]>;
  onCreatePanel: (title: string, description: string) => void;
  onAddButton: (panelId: number, data: { label: string; style: string; action_type: string; action_value: string }) => void;
  onDeleteButton: (panelId: number, buttonId: number) => void;
  onPostPanel: (panelId: number, channelId: string) => void;
}) {
  const [title, setTitle] = useState("");
  const [desc, setDesc] = useState("");

  return (
    <section className="stack">
      <div className="card" style={{ padding: 24 }}>
        <h2>新規パネル作成</h2>
        <div className="form-grid two">
          <label className="field">
            <span>タイトル</span>
            <input value={title} onChange={e => setTitle(e.target.value)} />
          </label>
          <label className="field">
            <span>説明文（任意）</span>
            <input value={desc} onChange={e => setDesc(e.target.value)} />
          </label>
        </div>
        <div className="button-row">
          <button
            className="primary"
            onClick={() => {
              onCreatePanel(title, desc);
              setTitle("");
              setDesc("");
            }}
          >
            作成
          </button>
        </div>
      </div>

      {panels.map(p => (
        <PanelCard key={p.id} panel={p} meta={meta} buttons={panelButtons[p.id] ?? []} onAddButton={onAddButton} onDeleteButton={onDeleteButton} onPost={onPostPanel} />
      ))}
    </section>
  );
}

function PanelCard({
  panel,
  meta,
  buttons,
  onAddButton,
  onDeleteButton,
  onPost
}: {
  panel: Panel;
  meta: Meta;
  buttons: PanelButton[];
  onAddButton: (panelId: number, data: { label: string; style: string; action_type: string; action_value: string }) => void;
  onDeleteButton: (panelId: number, buttonId: number) => void;
  onPost: (panelId: number, channelId: string) => void;
}) {
  const [label, setLabel] = useState("");
  const [style, setStyle] = useState("Primary");
  const [actionType, setActionType] = useState("toggle_role");
  const [actionValue, setActionValue] = useState("");
  const [channelId, setChannelId] = useState("");

  return (
    <div className="card" style={{ padding: 24 }}>
      <div className="section-head">
        <h2>{panel.title}</h2>
      </div>
      {panel.description && <p className="muted">{panel.description}</p>}

      <div className="button-row" style={{ flexWrap: "wrap" }}>
        {buttons.map(b => (
          <span key={b.id} className="status-pill">
            {b.label} ({STYLE_LABEL[b.style] ?? b.style})
            <button className="icon-button" onClick={() => onDeleteButton(panel.id, b.id)} title="削除">
              ×
            </button>
          </span>
        ))}
      </div>

      <div className="form-grid three" style={{ marginTop: 16 }}>
        <label className="field">
          <span>ラベル</span>
          <input value={label} onChange={e => setLabel(e.target.value)} />
        </label>
        <label className="field">
          <span>色</span>
          <select value={style} onChange={e => setStyle(e.target.value)}>
            {Object.entries(STYLE_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>アクション</span>
          <select value={actionType} onChange={e => setActionType(e.target.value)}>
            <option value="toggle_role">ロール付与/剥奪</option>
            <option value="show_text">テキスト表示</option>
          </select>
        </label>
        <label className="field" style={{ gridColumn: "1 / -1" }}>
          <span>ロールID or テキスト</span>
          <input value={actionValue} onChange={e => setActionValue(e.target.value)} />
        </label>
      </div>
      <div className="button-row">
        <button
          className="secondary"
          onClick={() => {
            if (!label.trim() || !actionValue.trim()) return;
            onAddButton(panel.id, { label: label.trim(), style, action_type: actionType, action_value: actionValue.trim() });
            setLabel("");
            setActionValue("");
          }}
        >
          ボタン追加
        </button>
      </div>

      <div className="form-grid two" style={{ marginTop: 16 }}>
        <label className="field">
          <span>投稿先チャンネル</span>
          <select value={channelId} onChange={e => setChannelId(e.target.value)}>
            <option value="">チャンネルを選択</option>
            {meta.channels.map(c => (
              <option key={c.id} value={c.id}>
                #{c.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="button-row">
        <button className="primary" onClick={() => onPost(panel.id, channelId)} disabled={!channelId}>
          投稿
        </button>
      </div>
    </div>
  );
}

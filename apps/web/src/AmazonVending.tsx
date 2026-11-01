import { useEffect, useState } from "react";

type Channel = { id: string; name: string; type: number; parent_id: string | null };
type Role = { id: string; name: string; color: number };
type Meta = { id: string; name: string; icon: string | null; channels: Channel[]; roles: Role[] };

export type AvConfig = {
  panel_title: string;
  panel_description: string | null;
  ltc_address: string | null;
  api_type: string;
  api_key: string | null;
};

export default function AmazonVending({
  meta,
  avConfig,
  onSave,
  onPost
}: {
  meta: Meta;
  avConfig: AvConfig;
  onSave: (cfg: AvConfig) => void;
  onPost: (channelId: string) => void;
}) {
  const [draft, setDraft] = useState(avConfig);
  const [channelId, setChannelId] = useState("");
  useEffect(() => setDraft(avConfig), [avConfig]);

  return (
    <section className="stack">
      <div className="card" style={{ padding: 24 }}>
        <div className="section-head">
          <h2>Amazon自販機 設定</h2>
          <button className="primary" onClick={() => onSave(draft)}>
            設定保存
          </button>
        </div>
        <div className="form-grid two">
          <label className="field" style={{ gridColumn: "1 / -1" }}>
            <span>パネルタイトル</span>
            <input maxLength={100} value={draft.panel_title} onChange={e => setDraft({ ...draft, panel_title: e.target.value })} />
          </label>
          <label className="field" style={{ gridColumn: "1 / -1" }}>
            <span>パネル説明文</span>
            <textarea maxLength={500} value={draft.panel_description ?? ""} onChange={e => setDraft({ ...draft, panel_description: e.target.value })} />
          </label>
          <label className="field" style={{ gridColumn: "1 / -1" }}>
            <span>LTCアドレス</span>
            <input placeholder="Lxxxxxxxxxx..." value={draft.ltc_address ?? ""} onChange={e => setDraft({ ...draft, ltc_address: e.target.value })} />
          </label>
          <label className="field">
            <span>API種別</span>
            <select value={draft.api_type} onChange={e => setDraft({ ...draft, api_type: e.target.value })}>
              <option value="rainforest">Rainforest API</option>
              <option value="keepa">Keepa API</option>
              <option value="canopy">Canopy API</option>
            </select>
          </label>
          <label className="field">
            <span>APIキー</span>
            <input type="password" value={draft.api_key ?? ""} onChange={e => setDraft({ ...draft, api_key: e.target.value })} />
          </label>
        </div>
      </div>

      <div className="card" style={{ padding: 24 }}>
        <h2>パネルを設置</h2>
        <div className="form-grid two">
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
          <button className="primary" onClick={() => onPost(channelId)} disabled={!channelId}>
            投稿
          </button>
        </div>
      </div>
    </section>
  );
}

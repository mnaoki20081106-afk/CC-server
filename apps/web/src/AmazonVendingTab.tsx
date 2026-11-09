import { useEffect, useMemo, useState } from "react";
import { api } from "./api";
import AmazonVending, { type AvConfig } from "./AmazonVending";

// Amazon自販機 (CC-server) タブ。AmazonVending.tsx は CC-server のまま無改変で使い、
// 設定の読み込み・保存・パネル投稿 (CC-server の App.tsx にあった処理) をここに置く。

type MetaChannel = {
  id: string;
  name: string;
  type?: "text" | "voice" | "announcement" | "stage" | "forum" | "media";
  parentId?: string | null;
};
type MetaRole = { id: string; name: string; color: number };

const CHANNEL_TYPE_CODE: Record<string, number> = {
  text: 0,
  voice: 2,
  announcement: 5,
  stage: 13,
  forum: 15,
  media: 16
};

export default function AmazonVendingTab({
  guildId,
  guildName,
  guildIcon,
  channels,
  roles,
  onNotice,
  onError
}: {
  guildId: string;
  guildName: string;
  guildIcon: string | null;
  channels: MetaChannel[];
  roles: MetaRole[];
  onNotice: (message: string) => void;
  onError: (reason: unknown) => void;
}) {
  const [avConfig, setAvConfig] = useState<AvConfig | null>(null);

  // AmazonVending.tsx が期待する CC-server 形式の meta に変換 (パネルを投稿できるチャンネルのみ)
  const meta = useMemo(() => ({
    id: guildId,
    name: guildName,
    icon: guildIcon,
    channels: channels
      .filter(channel => !channel.type || channel.type === "text" || channel.type === "announcement")
      .map(channel => ({
        id: channel.id,
        name: channel.name,
        type: CHANNEL_TYPE_CODE[channel.type ?? "text"] ?? 0,
        parent_id: channel.parentId ?? null
      })),
    roles: roles.map(role => ({ id: role.id, name: role.name, color: role.color }))
  }), [guildId, guildName, guildIcon, channels, roles]);

  useEffect(() => {
    let cancelled = false;
    setAvConfig(null);
    api<AvConfig>(`/api/guilds/${guildId}/amazon-vending`)
      .then(cfg => { if (!cancelled) setAvConfig(cfg); })
      .catch(reason => { if (!cancelled) onError(reason); });
    return () => { cancelled = true; };
  }, [guildId]);

  async function saveAvConfig(patch: AvConfig) {
    try {
      await api(`/api/guilds/${guildId}/amazon-vending`, { method: "PUT", body: JSON.stringify(patch) });
      setAvConfig(patch);
      onNotice("設定を保存しました");
    } catch (reason) {
      onError(reason);
    }
  }

  async function postAvPanel(channelId: string) {
    if (!channelId) return;
    try {
      await api(`/api/guilds/${guildId}/amazon-vending/panel`, { method: "POST", body: JSON.stringify({ channel_id: channelId }) });
      onNotice("パネルを投稿しました");
    } catch (reason) {
      onError(reason);
    }
  }

  if (!avConfig) return <p className="muted">読み込み中…</p>;
  return <AmazonVending meta={meta} avConfig={avConfig} onSave={saveAvConfig} onPost={postAvPanel} />;
}

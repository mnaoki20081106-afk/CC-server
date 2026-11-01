import { useState } from "react";

export type PreviewButton = { label: string; style: 1 | 2 | 3 | 4; emoji?: string | null };

const STYLE_CLASS: Record<number, string> = { 1: "style-1", 2: "style-2", 3: "style-3", 4: "style-4" };

export default function DiscordPanelPreview({
  title,
  description,
  footer,
  color,
  buttons,
  onTitleChange,
  onDescriptionChange,
  titlePlaceholder,
  descriptionPlaceholder,
  disabled = false
}: {
  title: string;
  description: string;
  footer?: string | null;
  color: number;
  buttons: PreviewButton[];
  onTitleChange?: (value: string) => void;
  onDescriptionChange?: (value: string) => void;
  titlePlaceholder?: string;
  descriptionPlaceholder?: string;
  disabled?: boolean;
}) {
  const [editing, setEditing] = useState<"title" | "description" | null>(null);
  const [mobile, setMobile] = useState(false);
  const [viewOnly, setViewOnly] = useState(false);
  const titleEditable = !disabled && !viewOnly && Boolean(onTitleChange);
  const descriptionEditable = !disabled && !viewOnly && Boolean(onDescriptionChange);

  return (
    <section className="discord-panel-studio" aria-label="パネルのプレビュー">
      <div className="section-head">
        <div>
          <h3>パネルを見ながら編集</h3>
          <p>タイトル・説明を選んで編集できます。変更後は保存して反映してください。</p>
        </div>
        <div className="button-row wrap-row" aria-label="プレビュー幅">
          <button
            type="button"
            className="secondary"
            aria-pressed={viewOnly}
            onClick={() => {
              setEditing(null);
              setViewOnly(v => !v);
            }}
          >
            {viewOnly ? "編集に戻る" : "表示のみ"}
          </button>
          <button type="button" className="secondary" aria-pressed={!mobile} onClick={() => setMobile(false)}>
            PC
          </button>
          <button type="button" className="secondary" aria-pressed={mobile} onClick={() => setMobile(true)}>
            スマホ
          </button>
        </div>
      </div>
      <div className={"discord-panel-preview" + (mobile ? " is-mobile" : "")} data-testid="discord-panel-preview">
        <div className="discord-panel-embed" style={{ borderLeftColor: "#" + color.toString(16).padStart(6, "0") }}>
          {titleEditable && editing === "title" ? (
            <input
              className="discord-inline-input discord-panel-title"
              aria-label="プレビューのタイトル"
              autoFocus
              maxLength={256}
              value={title}
              placeholder={titlePlaceholder}
              onChange={e => onTitleChange?.(e.target.value)}
              onBlur={() => setEditing(null)}
            />
          ) : (
            <div
              className={"discord-panel-title" + (titleEditable ? " discord-editable" : "")}
              role={titleEditable ? "button" : undefined}
              tabIndex={titleEditable ? 0 : undefined}
              aria-label={titleEditable ? "プレビューのタイトルを編集" : undefined}
              onClick={() => titleEditable && setEditing("title")}
              onKeyDown={e => {
                if (titleEditable && (e.key === "Enter" || e.key === " ")) {
                  e.preventDefault();
                  setEditing("title");
                }
              }}
            >
              {title || titlePlaceholder}
            </div>
          )}
          <div className="discord-panel-description">
            {descriptionEditable && editing === "description" ? (
              <textarea
                className="discord-inline-input"
                aria-label="プレビューの説明"
                autoFocus
                maxLength={3000}
                rows={4}
                value={description}
                placeholder={descriptionPlaceholder}
                onChange={e => onDescriptionChange?.(e.target.value)}
                onBlur={() => setEditing(null)}
              />
            ) : (
              (description || descriptionPlaceholder) && (
                <div
                  className={"discord-panel-section" + (descriptionEditable ? " discord-editable" : "")}
                  role={descriptionEditable ? "button" : undefined}
                  tabIndex={descriptionEditable ? 0 : undefined}
                  aria-label={descriptionEditable ? "プレビューの説明を編集" : undefined}
                  onClick={() => descriptionEditable && setEditing("description")}
                  onKeyDown={e => {
                    if (descriptionEditable && (e.key === "Enter" || e.key === " ")) {
                      e.preventDefault();
                      setEditing("description");
                    }
                  }}
                >
                  {description || descriptionPlaceholder}
                </div>
              )
            )}
          </div>
          {footer && <div className="discord-panel-footer">{footer}</div>}
        </div>
        <div className="discord-panel-actions">
          {buttons.map((b, i) => (
            <button
              key={i}
              type="button"
              className={"discord-action " + (STYLE_CLASS[b.style] ?? "style-1")}
              aria-disabled="true"
              title="プレビューのため操作は行いません"
              onClick={() => {}}
            >
              {b.emoji ? b.emoji + " " : ""}
              {b.label}
            </button>
          ))}
        </div>
      </div>
      <p className="muted">実際の見た目はDiscordの端末・テーマにより折り返しなどが異なります。</p>
    </section>
  );
}

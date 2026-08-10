import { type ImportSourcesResponse, api } from "@/lib/api";
import { Loader2, RotateCcw, Upload, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

export function ImportSourcesDialog({
	open,
	onClose,
	onImported,
}: {
	open: boolean;
	onClose: () => void;
	onImported: () => void;
}) {
	const inputRef = useRef<HTMLInputElement>(null);
	const [files, setFiles] = useState<File[]>([]);
	const [desktopPaths, setDesktopPaths] = useState<string[]>([]);
	const [duplicateMode, setDuplicateMode] = useState<"skip" | "replace" | "reimport">("skip");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [result, setResult] = useState<ImportSourcesResponse | null>(null);

	useEffect(() => {
		if (!open) return;
		setFiles([]);
		setDesktopPaths([]);
		setDuplicateMode("skip");
		setBusy(false);
		setError(null);
		setResult(null);
	}, [open]);

	if (!open) return null;

	const choose = (selected: FileList | null) => {
		if (!selected) return;
		setFiles(Array.from(selected));
		setDesktopPaths([]);
		setResult(null);
		setError(null);
	};

	const importFiles = async (targetFiles: readonly File[], targetPaths: readonly string[] = []) => {
		if (targetFiles.length === 0 && targetPaths.length === 0) return;
		if (busy) return;
		setBusy(true);
		setError(null);
		setResult(null);
		const response = await api.importSources(targetFiles, duplicateMode, targetPaths);
		setBusy(false);
		if (!response.ok || !response.data) {
			setError(response.error ?? "Import failed");
			return;
		}
		setResult(response.data);
		onImported();
	};

	const submit = () => void importFiles(files, desktopPaths);

	const chooseDesktop = async () => {
		if (busy) return;
		setError(null);
		const response = await api.pickFiles();
		if (!response.ok || !response.paths) {
			setError(response.error ?? "Native file picker unavailable");
			return;
		}
		setFiles([]);
		setDesktopPaths(response.paths);
		setResult(null);
	};

	const retryFailed = () => {
		if (!result) return;
		const failedNames = new Set(result.files.filter((file) => file.status === "failed").map((file) => file.fileName));
		void importFiles(
			files.filter((file) => failedNames.has(file.name)),
			desktopPaths.filter((path) => failedNames.has(path.split(/[\\/]/).pop() ?? path)),
		);
	};

	return (
		<div
			className="cs-backdrop"
			role="presentation"
			onClick={(event) => {
				if (event.target === event.currentTarget && !busy) onClose();
			}}
			onKeyDown={(event) => {
				if (event.key === "Escape" && !busy) onClose();
			}}
		>
			<dialog open className="cs-panel" aria-modal="true" aria-label="Import files">
				<header className="cs-head">
					<span className="cs-title">Import files</span>
					<button type="button" className="cs-close" onClick={onClose} disabled={busy} aria-label="Close">
						<X className="size-4" />
					</button>
				</header>
				<div className="cs-body">
					<button
						type="button"
						className="flex min-h-28 w-full flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-[oklch(1_0_0/0.14)] bg-[color-mix(in_oklch,var(--foreground)_3%,transparent)] text-muted-foreground hover:border-success hover:text-foreground"
						onClick={() => inputRef.current?.click()}
						disabled={busy}
					>
						<Upload className="size-5" />
						<span className="text-xs font-medium">Choose one or more files</span>
						<span className="font-mono text-[9px]">JSON · Markdown · CSV · HTML · documents</span>
					</button>
					<button type="button" className="cs-btn-ghost self-center" onClick={chooseDesktop} disabled={busy}>
						Choose from desktop
					</button>
					<input
						ref={inputRef}
						type="file"
						multiple
						className="hidden"
						accept=".txt,.md,.markdown,.json,.html,.htm,.csv,.doc,.docx,.docm,.odt,.rtf,.pdf,.ppt,.pptx,.ppsx,.odp,.epub,.xls,.xlsx,.xlsm,.ods"
						onChange={(event) => choose(event.target.files)}
					/>
					{(files.length > 0 || desktopPaths.length > 0) && (
						<div className="flex flex-col gap-1 rounded-md bg-[color-mix(in_oklch,var(--foreground)_3%,transparent)] p-2 font-mono text-[10px]">
							{files.map((file) => (
								<span key={`${file.name}:${file.size}`} className="truncate">
									{file.name} · {(file.size / 1024).toFixed(0)} KB
								</span>
							))}
							{desktopPaths.map((path) => (
								<span key={path} className="truncate">
									{path.split(/[\\/]/).pop() ?? path} · desktop path
								</span>
							))}
						</div>
					)}
					<label className="cs-field">
						<span className="cs-field__label">If a content hash already exists</span>
						<select
							className="cs-field__input"
							value={duplicateMode}
							onChange={(event) => setDuplicateMode(event.target.value as typeof duplicateMode)}
							disabled={busy}
						>
							<option value="skip">Skip duplicate</option>
							<option value="replace">Replace and re-index</option>
							<option value="reimport">Import as a new source</option>
						</select>
					</label>
					{busy && (
						<div className="cs-field__hint" aria-live="polite">
							Importing {files.length} {files.length === 1 ? "file" : "files"}…
						</div>
					)}
					{result && (
						<div className="flex flex-col gap-2" aria-live="polite">
							<div className="cs-field__hint">
								Imported {result.imported}; failed {result.failed}.
							</div>
							<div className="flex flex-col gap-1 rounded-md bg-[color-mix(in_oklch,var(--foreground)_3%,transparent)] p-2 text-[10px]">
								{result.files.map((file) => (
									<div key={`${file.fileName}:${file.status}`} className="flex items-start justify-between gap-2">
										<span className="min-w-0 truncate font-mono">{file.fileName}</span>
										<span className={file.status === "failed" ? "text-destructive" : "text-success"}>
											{file.status === "failed" ? file.error : file.status === "duplicate" ? "duplicate" : "indexed"}
										</span>
									</div>
								))}
							</div>
							{result.failed > 0 && (
								<button type="button" className="cs-btn-ghost self-start" onClick={retryFailed} disabled={busy}>
									<RotateCcw className="size-3" />
									Retry failed
								</button>
							)}
						</div>
					)}
					{error && <div className="cs-error">{error}</div>}
				</div>
				<footer className="cs-foot">
					<button type="button" className="cs-btn-ghost" onClick={onClose} disabled={busy}>
						Close
					</button>
					<button
						type="button"
						className="cs-btn-primary"
						onClick={submit}
						disabled={busy || (files.length === 0 && desktopPaths.length === 0)}
					>
						{busy && <Loader2 className="size-3.5 animate-spin" />}
						Import &amp; index
					</button>
				</footer>
			</dialog>
		</div>
	);
}

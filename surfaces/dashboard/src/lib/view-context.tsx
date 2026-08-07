import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

export type ViewId =
	| "home"
	| "agents"
	| "memory"
	| "sources"
	| "graph"
	| "dreaming"
	| "skills"
	| "secrets";

const VIEW_LABELS: Record<ViewId, string> = {
	home: "Home",
	agents: "Agents",
	memory: "Memory",
	sources: "Sources",
	graph: "Graph",
	dreaming: "Dreams",
	skills: "Skills",
	secrets: "Secrets",
};

/** Parse `#graph` / `#/graph` into a view id; unknown or absent hashes return null. */
function viewFromHash(): ViewId | null {
	if (typeof window === "undefined") return null;
	const raw = window.location.hash.replace(/^#\/?/, "").trim();
	return (raw in VIEW_LABELS ? raw : null) as ViewId | null;
}

interface ViewCtx {
	view: ViewId;
	setView: (v: ViewId) => void;
	label: (v: ViewId) => string;
	/** Cross-view handoff: navigate to sources and land in the connect flow. */
	connectSourceRequested: boolean;
	requestConnectSource: () => void;
	clearConnectSource: () => void;
}

const Ctx = createContext<ViewCtx | null>(null);

export function ViewProvider({ children }: { children: ReactNode }) {
	const [view, setViewState] = useState<ViewId>(() => viewFromHash() ?? "home");
	const [connectSourceRequested, setConnectSourceRequested] = useState(false);

	// Views are deep-linkable via location.hash (the marketing-site demo iframe
	// drives the embedded dashboard by setting its hash). Keep the hash in sync
	// on every navigation so the URL always reflects the visible view.
	const setView = useCallback((next: ViewId) => {
		setViewState(next);
		if (typeof window !== "undefined" && window.location.hash !== `#${next}`) {
			history.replaceState(null, "", `#${next}`);
		}
	}, []);

	useEffect(() => {
		const onHashChange = () => {
			const next = viewFromHash();
			if (next) setViewState(next);
		};
		window.addEventListener("hashchange", onHashChange);
		return () => window.removeEventListener("hashchange", onHashChange);
	}, []);

	return (
		<Ctx.Provider
			value={{
				view,
				setView,
				label: (v) => VIEW_LABELS[v],
				connectSourceRequested,
				requestConnectSource: () => {
					setConnectSourceRequested(true);
					setView("sources");
				},
				clearConnectSource: () => setConnectSourceRequested(false),
			}}
		>
			{children}
		</Ctx.Provider>
	);
}

export function useView(): ViewCtx {
	const ctx = useContext(Ctx);
	if (!ctx) throw new Error("useView must be used within ViewProvider");
	return ctx;
}

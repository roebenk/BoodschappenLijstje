"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { AnimatePresence } from "motion/react";
import { ChevronDown, ChevronRight, History, Loader2, Plus, ShoppingBasket, X } from "lucide-react";
import { ItemComparisonSheet } from "@/components/ItemComparisonSheet";
import { PushToStoresSheet } from "@/components/PushToStoresSheet";
import { ListRow } from "@/components/ListRow";
import { BasketSummarySheet, BottomSummaryBar, type StoreFilter } from "@/components/OptimizerCard";
import { ShoppingModeView } from "@/components/ShoppingModeView";
import { Card, PageHeader, SyncPill, btnSecondary } from "@/components/ui";
import { api } from "@/hooks/api";
import { useHouseholdSync } from "@/hooks/useHouseholdSync";
import type {
  AddListItemsResponse,
  DemoSeedResponse,
  ListOptimizationResult,
  ListResponse,
  ListSuggestionsResponse,
  PreferencesResponse,
  ShoppingListItem,
  UpdateListItemRequest,
  UpdateListItemResponse,
} from "@/lib/types";

const SPOTLIGHT_MS = 16_000;

type AddJob = { id: number; inputs: string[]; status: "queued" | "searching" | "failed" };

function suggestionKey(value: string) {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("nl");
}

export default function Home() {
  const [list, setList] = useState<ListResponse | null>(null);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [input, setInput] = useState("");
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [addJobs, setAddJobs] = useState<AddJob[]>([]);
  const [recentlyAddedIds, setRecentlyAddedIds] = useState<Set<number>>(() => new Set());
  const [optimizing, setOptimizing] = useState(false);
  const [filter, setFilter] = useState<StoreFilter>("all");
  const [preShopFilter, setPreShopFilter] = useState<StoreFilter>("all");
  const [openId, setOpenId] = useState<number | null>(null);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [pushOpen, setPushOpen] = useState(false);
  const [shoppingMode, setShoppingMode] = useState(false);
  const [showChecked, setShowChecked] = useState(false);
  const [prefsEmpty, setPrefsEmpty] = useState(false);
  const [seeding, setSeeding] = useState(false);
  const inFlightPatchRef = useRef<Promise<void>>(Promise.resolve());
  const pendingPatchIds = useRef(new Set<number>());
  const [pendingIds, setPendingIds] = useState<Set<number>>(() => new Set());
  const listReadVersion = useRef(0);
  const addTailRef = useRef<Promise<void>>(Promise.resolve());
  const nextAddIdRef = useRef(0);
  const quickAddRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const spotlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scheduleSpotlightClear = useCallback((ms = SPOTLIGHT_MS) => {
    if (spotlightTimerRef.current) clearTimeout(spotlightTimerRef.current);
    spotlightTimerRef.current = setTimeout(() => {
      setRecentlyAddedIds(new Set());
    }, ms);
  }, []);

  useEffect(() => {
    return () => {
      if (spotlightTimerRef.current) clearTimeout(spotlightTimerRef.current);
    };
  }, []);

  const refresh = useCallback(async () => {
    const version = ++listReadVersion.current;
    try {
      const next = await api<ListResponse>("/api/list");
      if (version === listReadVersion.current) setList(next);
    } catch (e) {
      if (version === listReadVersion.current) {
        toast.error(e instanceof Error ? e.message : "Lijst laden mislukt");
      }
    }
  }, []);

  const refreshPrefs = useCallback(async () => {
    try {
      const p = await api<PreferencesResponse>("/api/preferences");
      setPrefsEmpty(p.preferences.length === 0);
    } catch {
      /* non-critical */
    }
  }, []);

  const refreshSuggestions = useCallback(async () => {
    try {
      const result = await api<ListSuggestionsResponse>("/api/list/suggestions");
      setSuggestions(result.suggestions);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Suggesties laden mislukt");
    }
  }, []);

  const refreshAll = useCallback(() => {
    void refresh();
    void refreshPrefs();
    void refreshSuggestions();
  }, [refresh, refreshPrefs, refreshSuggestions]);

  const { connected } = useHouseholdSync(refreshAll);

  useEffect(() => {
    refreshAll();
  }, [refreshAll]);

  useEffect(() => {
    if (!showSuggestions) return;
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !quickAddRef.current?.contains(event.target)) {
        setShowSuggestions(false);
      }
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [showSuggestions]);

  const dismissJob = (id: number) => setAddJobs((jobs) => jobs.filter((job) => job.id !== id));

  const enqueueAdd = (inputs: string[]) => {
    if (inputs.length === 0) return;
    const id = nextAddIdRef.current++;
    setAddJobs((jobs) => [...jobs, { id, inputs, status: "queued" }]);
    addTailRef.current = addTailRef.current.then(async () => {
      const setStatus = (status: AddJob["status"]) =>
        setAddJobs((jobs) => jobs.map((job) => job.id === id ? { ...job, status } : job));

      setStatus("searching");
      try {
        const { items } = await api<AddListItemsResponse>("/api/list", { method: "POST", body: { inputs } });
        if (items.length > 0) {
          setFilter((current) =>
            current !== "all" && items.some((item) => item.assignedProvider !== current) ? "all" : current,
          );
          setRecentlyAddedIds((current) => new Set([...current, ...items.map((item) => item.id)]));
          scheduleSpotlightClear();
        }
      } catch (e) {
        setStatus("failed");
        toast.error(e instanceof Error ? e.message : "Toevoegen mislukt");
        return;
      }

      await refresh();
      dismissJob(id);
    });
  };

  const dismissSpotlight = useCallback((id: number) => {
    setRecentlyAddedIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const patchItem = async (id: number, patch: UpdateListItemRequest) => {
    if (pendingPatchIds.current.has(id)) return false;
    pendingPatchIds.current.add(id);
    setPendingIds(new Set(pendingPatchIds.current));
    const prevItem = list?.items.find((i) => i.id === id);
    dismissSpotlight(id);

    if (patch.isChecked !== undefined) {
      setList((curr) => {
        if (!curr) return curr;
        const items = curr.items.map((it) => {
          if (it.id !== id) return it;
          return { ...it, isChecked: !!patch.isChecked };
        });
        const ahSub = items
          .filter((i) => !i.isChecked && i.assignedProvider === "ah")
          .reduce((s, i) => s + (i.ahTotalCents ?? 0), 0);
        const prSub = items
          .filter((i) => !i.isChecked && i.assignedProvider === "picnic")
          .reduce((s, i) => s + (i.picnicTotalCents ?? 0), 0);
        return {
          ...curr,
          items,
          ahSubtotalCents: ahSub,
          picnicSubtotalCents: prSub,
          totalCents: ahSub + prSub,
          picnicAdvice: {
            ...curr.picnicAdvice,
            currentPicnicCents: prSub,
            meetsMinimum: prSub >= curr.picnicAdvice.minOrderCents,
            shortfallCents: prSub > 0 ? Math.max(0, curr.picnicAdvice.minOrderCents - prSub) : 0,
          },
        };
      });
    }

    const run = inFlightPatchRef.current.then(async () => {
      try {
        const { item: updated } = await api<UpdateListItemResponse>(`/api/list/${id}`, { method: "PATCH", body: patch });
        // A list read started before this confirmation can still contain the old assignment.
        ++listReadVersion.current;
        setList((curr) => curr && { ...curr, items: curr.items.map((it) => it.id === id ? updated : it) });
        if (patch.isProviderLocked !== undefined || patch.assignedProvider !== undefined) {
          const storeName = updated.assignedProvider === "picnic" ? "Picnic"
            : updated.assignedProvider === "ah" ? "Albert Heijn" : null;
          if (updated.isProviderLocked && storeName) {
            toast.success(`Vastgezet op ${storeName}`);
          } else if (storeName && prevItem && updated.assignedProvider !== prevItem.assignedProvider) {
            toast.success(`Ontgrendeld — verplaatst naar ${storeName}`);
          } else {
            toast.success("Ontgrendeld — winkelkeuze staat weer op automatisch");
          }
        }
        await refresh();
        return true;
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Bijwerken mislukt");
        await refresh();
        return false;
      } finally {
        pendingPatchIds.current.delete(id);
        setPendingIds(new Set(pendingPatchIds.current));
      }
    });
    inFlightPatchRef.current = run.then(() => {});
    return run;
  };

  const deleteItem = async (id: number) => {
    dismissSpotlight(id);
    setList((current) => {
      if (!current || !current.items.some((item) => item.id === id)) return current;
      const items = current.items.filter((item) => item.id !== id);
      const ahSubtotalCents = items
        .filter((item) => !item.isChecked && item.assignedProvider === "ah")
        .reduce((sum, item) => sum + (item.ahTotalCents ?? 0), 0);
      const picnicSubtotalCents = items
        .filter((item) => !item.isChecked && item.assignedProvider === "picnic")
        .reduce((sum, item) => sum + (item.picnicTotalCents ?? 0), 0);
      return {
        ...current,
        items,
        ahSubtotalCents,
        picnicSubtotalCents,
        totalCents: ahSubtotalCents + picnicSubtotalCents,
        picnicAdvice: {
          ...current.picnicAdvice,
          currentPicnicCents: picnicSubtotalCents,
          meetsMinimum: picnicSubtotalCents >= current.picnicAdvice.minOrderCents,
          shortfallCents:
            picnicSubtotalCents > 0
              ? Math.max(0, current.picnicAdvice.minOrderCents - picnicSubtotalCents)
              : 0,
        },
      };
    });

    const run = inFlightPatchRef.current.then(async () => {
      try {
        await api(`/api/list/${id}`, { method: "DELETE" });
        await refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Verwijderen mislukt");
        await refresh();
      }
    });
    inFlightPatchRef.current = run;
    await run;
  };

  const optimize = async (mode: "optimal" | "all_ah") => {
    setOptimizing(true);
    const run = inFlightPatchRef.current.then(async () => {
      try {
        const res = await api<ListOptimizationResult>("/api/list/optimize", { method: "POST", body: { forceMode: mode } });
        ++listReadVersion.current;
        setList(res);
        toast.success(mode === "all_ah" ? "Lijstje aangepast met behoud van vaste winkelkeuzes" : "Lijstje geoptimaliseerd");
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Optimaliseren mislukt");
      } finally {
        setOptimizing(false);
      }
    });
    inFlightPatchRef.current = run;
    await run;
  };

  const clearChecked = async () => {
    try {
      await api("/api/list?checked=1", { method: "DELETE" });
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Wissen mislukt");
    }
  };

  const seed = async () => {
    setSeeding(true);
    try {
      const r = await api<DemoSeedResponse>("/api/stores/demo-seed", { method: "POST" });
      toast.success(`${r.historyEntries} kassabon-regels geladen`);
      refreshAll();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Laden mislukt");
    } finally {
      setSeeding(false);
    }
  };

  const enterShoppingMode = (initialStore?: StoreFilter) => {
    setPreShopFilter(filter);
    if (initialStore) {
      setFilter(initialStore);
    } else if (filter === "all") {
      const ahOpen = (list?.items ?? []).filter((i) => !i.isChecked && i.assignedProvider === "ah").length;
      if (ahOpen > 0) setFilter("ah");
    }
    setShoppingMode(true);
  };

  const exitShoppingMode = () => {
    setShoppingMode(false);
    setFilter(preShopFilter);
  };

  const { open, checked, allOpenCount, ahOpenCount, picnicOpenCount } = useMemo(() => {
    const all = list?.items ?? [];
    const openAll = all.filter((i) => !i.isChecked);
    const filtered = all.filter((i) => filter === "all" || i.assignedProvider === filter);
    return {
      open: filtered.filter((i) => !i.isChecked),
      checked: filtered.filter((i) => i.isChecked),
      allOpenCount: openAll.length,
      ahOpenCount: openAll.filter((i) => i.assignedProvider === "ah").length,
      picnicOpenCount: openAll.filter((i) => i.assignedProvider === "picnic").length,
    };
  }, [list, filter]);

  const onList = new Set(
    (list?.items ?? []).flatMap((item) =>
      item.isChecked ? [] : [suggestionKey(item.rawInput), suggestionKey(item.displayName)],
    ),
  );
  const queuedNames = new Set(
    addJobs.filter((job) => job.status !== "failed").flatMap((job) => job.inputs.map(suggestionKey)),
  );
  const matchingSuggestions = suggestions.filter((name) => suggestionKey(name).includes(suggestionKey(input)));

  const isEmpty = list !== null && list.items.length === 0 && addJobs.length === 0;
  const showBottomBar = list !== null && list.items.length > 0 && !shoppingMode;
  const openedItem = useMemo(() => list?.items.find((i) => i.id === openId) ?? null, [list, openId]);
  const inShopping = shoppingMode && !!list && list.items.length > 0;

  return (
    // Keep scroll anchoring from compensating for the scroll-linked header height.
    <main
      className={`mx-auto max-w-xl overflow-x-clip [overflow-anchor:none] ${
        showBottomBar ? "pb-[calc(env(safe-area-inset-bottom)+9.5rem)]" : "pb-safe"
      }`}
    >
      <div className="sticky top-0 z-30 bg-[var(--canvas)]">
      <PageHeader
        collapseOnScroll
        title="Boodschappen"
        eyebrow={<SyncPill connected={connected} compact />}
        right={
          list && list.items.length > 0 ? (
            shoppingMode ? (
              <button
                type="button"
                data-testid="toggle-shopping-mode"
                aria-pressed={true}
                onClick={exitShoppingMode}
                className="inline-flex min-h-[38px] items-center gap-1.5 whitespace-nowrap rounded-full bg-[#34C759] px-3 text-[13.5px] font-semibold text-white transition-colors active:opacity-85"
              >
                <X className="h-4 w-4" /> Sluit winkel
              </button>
            ) : (
              <button
                type="button"
                data-testid="toggle-shopping-mode"
                aria-pressed={false}
                onClick={() => enterShoppingMode()}
                className="inline-flex min-h-[38px] items-center gap-1.5 whitespace-nowrap rounded-full bg-black/[0.07] px-3 text-[13.5px] font-semibold text-black/80 transition-colors active:opacity-75 dark:bg-white/12 dark:text-white/85"
              >
                <ShoppingBasket className="h-4 w-4" /> Winkelmodus
              </button>
            )
          ) : undefined
        }
      />

      {!inShopping && (
          <div className="px-4 pb-2 pt-1">
            <div
              ref={quickAddRef}
              className="relative z-10"
              onBlur={(e) => {
                if (e.relatedTarget && !e.currentTarget.contains(e.relatedTarget)) setShowSuggestions(false);
              }}
              onKeyDown={(e) => {
                if (e.key === "Escape" && showSuggestions) {
                  inputRef.current?.focus();
                  setShowSuggestions(false);
                }
              }}
            >
            <form
              autoComplete="off"
              onSubmit={(e) => {
                e.preventDefault();
                const inputs = input.split(/[\n,]/).map((value) => value.trim()).filter(Boolean);
                if (inputs.length === 0) return;
                enqueueAdd(inputs);
                setInput("");
                inputRef.current?.focus();
                setShowSuggestions(false);
              }}
              className="flex items-center gap-1.5 rounded-xl bg-[#E9E9EE] pl-3.5 pr-1.5 dark:bg-[#2C2C2E]"
            >
              <input
                ref={inputRef}
                data-testid="quick-add-input"
                value={input}
                onFocus={() => setShowSuggestions(true)}
                onClick={() => setShowSuggestions(true)}
                onChange={(e) => {
                  setInput(e.target.value);
                  setShowSuggestions(true);
                }}
                aria-label="Product zoeken en toevoegen"
                placeholder="Zoek of voeg een product toe…"
                enterKeyHint="go"
                autoComplete="off"
                className="min-h-[46px] min-w-0 flex-1 bg-transparent text-[16px] text-black outline-none placeholder:text-black/45 dark:text-white dark:placeholder:text-white/45"
              />
              {input.length > 0 && (
                <button
                  type="button"
                  aria-label="Invoer wissen"
                  onClick={() => setInput("")}
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-black/40 active:bg-black/10 dark:text-white/45 dark:active:bg-white/15"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
              <button
                type="button"
                aria-label="Vaak gekocht"
                aria-expanded={showSuggestions}
                aria-controls="purchase-suggestions"
                onClick={() => setShowSuggestions((open) => !open)}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] text-black/60 aria-expanded:bg-black/10 dark:text-white/70 dark:aria-expanded:bg-white/15"
              >
                <History className="h-5 w-5" />
              </button>
              <button
                data-testid="quick-add-submit"
                type="submit"
                disabled={!input.trim()}
                aria-label="Toevoegen"
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-[#007AFF] text-white transition-opacity disabled:opacity-35 dark:bg-[#0A84FF]"
              >
                <Plus className="h-5 w-5" strokeWidth={2.6} />
              </button>
            </form>
            <Card
              id="purchase-suggestions"
              hidden={!showSuggestions}
              className="absolute inset-x-0 top-full mt-1.5 max-h-[35dvh] !overflow-y-auto shadow-lg"
            >
              <p className="px-3.5 pb-1 pt-2.5 text-[12.5px] font-medium text-black/55 dark:text-white/60">
                Vaak gekocht in de afgelopen 3 maanden
              </p>
              {matchingSuggestions.length > 0 ? (
                <ul className="divide-y divide-black/[0.07] dark:divide-white/[0.09]">
                  {matchingSuggestions.map((name) => {
                    const key = suggestionKey(name);
                    const status = onList.has(key) ? "Op je lijst" : queuedNames.has(key) ? "In wachtrij" : null;
                    return (
                      <li key={name}>
                        <button
                          type="button"
                          aria-disabled={!!status}
                          onClick={() => {
                            if (!status) enqueueAdd([name]);
                            setShowSuggestions(false);
                          }}
                          className="flex min-h-[44px] w-full items-center justify-between gap-2 px-3.5 text-left text-[14px] font-semibold aria-disabled:opacity-55"
                        >
                          <span>{name}</span>
                          {status ? <span className="shrink-0 text-[12px]">{status}</span>
                            : <Plus aria-hidden="true" className="h-4 w-4 shrink-0 text-[#007AFF] dark:text-[#64B0FF]" />}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="px-3.5 pb-3 text-[14px] text-black/60 dark:text-white/60">
                  {suggestions.length ? "Geen passende aankopen." : "Geen suggesties uit recente aankopen."}
                </p>
              )}
            </Card>
            </div>

            {list && list.items.length > 0 && (
              <div
                className="mt-2 flex rounded-[10px] bg-black/[0.055] p-0.5 dark:bg-white/[0.09]"
                role="tablist"
                aria-label="Filter op winkel"
              >
                {(
                  [
                    ["all", "Alles", allOpenCount, null],
                    ["ah", "Albert Heijn", ahOpenCount, "#00ADE6"],
                    ["picnic", "Picnic", picnicOpenCount, "#E1191E"],
                  ] as const
                ).map(([key, label, count, dotColor]) => {
                  const active = filter === key;
                  return (
                    <button
                      key={key}
                      type="button"
                      role="tab"
                      aria-selected={active}
                      onClick={() => setFilter(key)}
                      className={`inline-flex min-h-[31px] flex-1 items-center justify-center gap-1.5 rounded-[8px] px-2 text-[12.5px] font-semibold tabular-nums transition-all ${
                        active
                          ? "bg-white text-black shadow-xs dark:bg-[#3A3A3C] dark:text-white"
                          : "text-black/55 active:text-black dark:text-white/60 dark:active:text-white"
                      }`}
                    >
                      {dotColor && <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: dotColor }} />}
                      <span>{label}</span>
                      <span className={`text-[11.5px] ${active ? "text-black/50 dark:text-white/60" : "opacity-75"}`}>
                        {count}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
      )}
      </div>

      {inShopping && list ? (
        <ShoppingModeView
          items={list.items}
          filter={filter}
          onFilter={setFilter}
          onToggleCheck={(id, nextChecked) => void patchItem(id, { isChecked: nextChecked })}
          onClearChecked={() => void clearChecked()}
        />
      ) : (
        <>
          <div className="space-y-3.5 px-4 pt-1.5">
            {list === null && (
              <p className="py-10 text-center text-[16px] text-black/60 dark:text-white/60">Laden…</p>
            )}

            {isEmpty && (
              <Card className="p-5 text-center">
                <p className="text-[18px] font-semibold">Je lijstje is leeg</p>
                <p className="mt-1 text-[14.5px] text-black/60 dark:text-white/60">
                  {suggestions.length > 0
                    ? "Typ hierboven wat je nodig hebt, of kies iets via Vaak gekocht."
                    : "Typ hierboven wat je nodig hebt."}
                </p>
                {prefsEmpty && (
                  <button onClick={seed} disabled={seeding} className={`${btnSecondary} mt-4`}>
                    {seeding ? "Laden…" : "Laad voorbeeld-kassabonnen"}
                  </button>
                )}
              </Card>
            )}

            {((list && !isEmpty) || addJobs.length > 0) && (
              <>
                <Card>
                  <ul className="divide-y divide-black/[0.07] dark:divide-white/[0.09]">
                    {addJobs.map(({ id, inputs, status }) => (
                      <li
                        key={`pending-${id}`}
                        data-testid="pending-item-row"
                        className="flex items-center gap-3 bg-[#007AFF]/[0.04] px-3.5 py-3 dark:bg-[#0A84FF]/[0.08]"
                      >
                        {status === "searching" && (
                          <Loader2 aria-hidden="true" className="h-4 w-4 shrink-0 animate-spin text-[#007AFF] dark:text-[#0A84FF]" />
                        )}
                        <div className="min-w-0 flex-1" role="status">
                          <p className="break-words text-[15px] font-semibold">{inputs.join(", ")}</p>
                          <p className="text-[12px] text-black/55 dark:text-white/55">
                            {status === "searching" ? "Producten zoeken bij AH en Picnic…"
                              : status === "queued" ? "In wachtrij" : "Toevoegen mislukt"}
                          </p>
                        </div>
                        {status === "failed" && (
                          <>
                            <button type="button" className={btnSecondary} onClick={() => {
                              dismissJob(id);
                              enqueueAdd(inputs);
                            }}>Opnieuw</button>
                            <button type="button" aria-label="Mislukte invoer verwijderen" onClick={() => dismissJob(id)}>
                              <X className="h-4 w-4" />
                            </button>
                          </>
                        )}
                      </li>
                    ))}
                    <AnimatePresence initial={false}>
                      {open.map((item) => (
                        <ListRow
                          key={item.id}
                          item={item}
                          isJustAdded={recentlyAddedIds.has(item.id)}
                          onPatch={patchItem}
                          patchPending={pendingIds.has(item.id)}
                          onDelete={(id) => void deleteItem(id)}
                          onOpen={(id) => {
                            dismissSpotlight(id);
                            setOpenId(id);
                          }}
                        />
                      ))}
                    </AnimatePresence>
                  </ul>

                  {open.length === 0 && addJobs.length === 0 && (
                    <div className="p-5 text-center">
                      {allOpenCount === 0 ? (
                        <p className="text-[15px] font-medium text-black/65 dark:text-white/65">Alles afgevinkt 🎉</p>
                      ) : (
                        <div className="space-y-1.5">
                          <p className="text-[14.5px] text-black/60 dark:text-white/60">
                            Geen open items bij {filter === "ah" ? "Albert Heijn" : "Picnic"}.
                          </p>
                          <button
                            type="button"
                            onClick={() => setFilter("all")}
                            className="text-[14px] font-semibold text-[#007AFF] dark:text-[#64B0FF]"
                          >
                            Toon alle {allOpenCount} open {allOpenCount === 1 ? "item" : "items"}
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </Card>

                {checked.length > 0 && (
                  <section>
                    <div className="flex items-center justify-between px-1">
                      <button
                        type="button"
                        onClick={() => setShowChecked((v) => !v)}
                        className="flex min-h-[40px] items-center gap-1 text-[14.5px] font-semibold text-black/65 dark:text-white/65"
                      >
                        {showChecked ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                        Afgevinkt ({checked.length})
                      </button>
                      <button
                        type="button"
                        onClick={clearChecked}
                        className="min-h-[40px] text-[14px] font-semibold text-[#FF3B30]"
                      >
                        Wis afgevinkt
                      </button>
                    </div>
                    {showChecked && (
                      <Card>
                        <ul className="divide-y divide-black/[0.07] dark:divide-white/[0.09]">
                          <AnimatePresence initial={false}>
                            {checked.map((item) => (
                              <ListRow
                                key={item.id}
                                item={item}
                                onPatch={patchItem}
                                patchPending={pendingIds.has(item.id)}
                                onDelete={(id) => void deleteItem(id)}
                                onOpen={setOpenId}
                              />
                            ))}
                          </AnimatePresence>
                        </ul>
                      </Card>
                    )}
                  </section>
                )}
              </>
            )}
          </div>
        </>
      )}

      {showBottomBar && list && (
        <BottomSummaryBar
          list={list}
          onOpenSummary={() => setSummaryOpen(true)}
          onOpenPush={() => setPushOpen(true)}
        />
      )}

      {list && (
        <BasketSummarySheet
          open={summaryOpen}
          onClose={() => setSummaryOpen(false)}
          list={list}
          filter={filter}
          onFilter={setFilter}
          busy={optimizing}
          onOptimize={optimize}
          onStartShoppingMode={(storeFilter) => enterShoppingMode(storeFilter)}
          onOpenPush={() => setPushOpen(true)}
        />
      )}

      <ItemComparisonSheet
        itemId={openId}
        initialItem={openedItem}
        onClose={() => setOpenId(null)}
        onPatch={patchItem}
        patchPending={openId !== null && pendingIds.has(openId)}
        onChanged={() => void refresh()}
      />
      <PushToStoresSheet open={pushOpen} onClose={() => setPushOpen(false)} onPushed={() => void refresh()} />
    </main>
  );
}

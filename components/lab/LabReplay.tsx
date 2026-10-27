"use client";

import { useEffect, useState } from "react";
import { IngredientList } from "@/components/scan/IngredientList";
import { ScanCanvas, type CanvasIngredient, type CanvasMask } from "@/components/scan/ScanCanvas";
import type { Dictionary } from "@/lib/i18n/dictionaries/en";
import { runPipeline } from "@/lib/pipeline/run";
import { replayProvider } from "@/lib/replay/provider";
import type { Recording } from "@/lib/replay/recording";

type State = { ingredients: CanvasIngredient[]; masks: CanvasMask[]; scanning: boolean };
const initial: State = { ingredients: [], masks: [], scanning: true };

/** Runs the real pipeline in the browser against a recording, so the lab needs no backend. */
export function LabReplay({ recording, t }: { recording: Recording; t: { scan: Dictionary["scan"]; replay: string } }) {
  const [run, setRun] = useState(0);
  const [state, setState] = useState<State>(initial);
  const [active, setActive] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const setSegmentation = (index: number, segmentation: CanvasIngredient["segmentation"]) =>
      setState((s) => ({
        ...s,
        ingredients: s.ingredients.map((i) => (i.key === `${run}-${index}` ? { ...i, segmentation } : i)),
      }));

    runPipeline(replayProvider(recording, { signal: controller.signal }), recording.image, {
      perceived: ({ perception }) =>
        setState((s) => ({
          ...s,
          ingredients: perception.ingredients.map((item, index) => ({
            key: `${run}-${index}`,
            name: item.name,
            daysLeft: item.daysLeft,
            bbox: item.bbox,
            segmentation: "pending",
          })),
        })),
      masks: (index, masks, via) => {
        setSegmentation(index, via);
        setState((s) => ({
          ...s,
          masks: [
            ...s.masks,
            ...masks.map((m) => ({ ...m, key: `${run}-${index}-${via}-${m.objectId}`, ingredientKey: `${run}-${index}` })),
          ],
        }));
      },
      unsegmented: (index) => setSegmentation(index, "none"),
    })
      .then(() => setState((s) => ({ ...s, scanning: false })))
      .catch(() => {
        // Aborted by a replay or by leaving the page.
      });

    return () => {
      controller.abort();
      setState(initial);
    };
  }, [recording, run]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => setRun((n) => n + 1)}
          className="rounded-full px-4 py-2 text-sm font-medium ring-1 ring-hairline transition-colors hover:bg-glass"
        >
          {t.replay}
        </button>
      </div>
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_300px] lg:items-start">
        <ScanCanvas
          image={recording.image}
          ingredients={state.ingredients}
          masks={state.masks}
          scanning={state.scanning}
          active={active}
          onActive={setActive}
          labels={t.scan}
        />
        <aside className="glass min-h-24 rounded-3xl p-4">
          <p className="px-2 pb-3 text-sm text-ink-soft">{t.scan.cookFirst}</p>
          <IngredientList ingredients={state.ingredients} active={active} onActive={setActive} labels={t.scan} />
        </aside>
      </div>
    </div>
  );
}

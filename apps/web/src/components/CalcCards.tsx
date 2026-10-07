import type { CalcResult } from "../protocol";
import type { CalcEntry } from "../state/reducer";
import { formatClockTime } from "../lib/format";
import { AlertIcon, CalculatorIcon } from "./Icons";

const KIND_LABEL: Record<CalcResult["kind"], string> = {
  dilution: "Dilution",
  "serial-dilution": "Serial dilution",
  "molar-solution": "Molar solution",
  "master-mix": "Master mix",
  "percent-solution": "Percent solution",
  "cell-seeding": "Cell seeding",
  "unit-conversion": "Unit conversion",
};

export function CalcCard({ entry, latest }: { entry: CalcEntry; latest: boolean }) {
  const r = entry.result;
  return (
    <article className={`calc-card${latest ? " is-latest" : ""}${r.warnings.length ? " has-warnings" : ""}`} aria-label={`${KIND_LABEL[r.kind] ?? r.kind} result`}>
      <header className="calc-head">
        <CalculatorIcon size={18} />
        <span className="calc-kind">{KIND_LABEL[r.kind] ?? r.kind}</span>
        <time className="calc-time">{formatClockTime(entry.at)}</time>
      </header>
      <p className="calc-summary">{r.summary}</p>
      {r.warnings.length > 0 && (
        <ul className="calc-warnings">
          {r.warnings.map((w, i) => (
            <li key={i}>
              <AlertIcon size={18} />
              <span>{w}</span>
            </li>
          ))}
        </ul>
      )}
      {r.table && r.table.rows.length > 0 && (
        <div className="table-wrap">
          <table className="calc-table">
            <thead>
              <tr>
                {r.table.columns.map((c, i) => (
                  <th key={i} scope="col">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {r.table.rows.map((row, i) => (
                <tr key={i}>
                  {row.map((cell, j) => (
                    <td key={j} className={typeof cell === "number" ? "num" : undefined}>
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {r.working.length > 0 && (
        <details className="calc-working">
          <summary>Show working</summary>
          <ol>
            {r.working.map((line, i) => (
              <li key={i}>
                <code>{line}</code>
              </li>
            ))}
          </ol>
        </details>
      )}
    </article>
  );
}

export function CalcList({ calcs }: { calcs: CalcEntry[] }) {
  if (calcs.length === 0) return null;
  const ordered = calcs.slice().reverse();
  return (
    <section className="panel calc-list" aria-labelledby="calc-heading">
      <h2 id="calc-heading" className="panel-title">
        Calculations <span className="count">{calcs.length}</span>
      </h2>
      <div className="calc-stack">
        {ordered.slice(0, 3).map((c, i) => (
          <CalcCard key={c.id} entry={c} latest={i === 0} />
        ))}
        {ordered.length > 3 && (
          <details className="calc-older">
            <summary>{ordered.length - 3} earlier calculations</summary>
            {ordered.slice(3).map((c) => (
              <CalcCard key={c.id} entry={c} latest={false} />
            ))}
          </details>
        )}
      </div>
    </section>
  );
}

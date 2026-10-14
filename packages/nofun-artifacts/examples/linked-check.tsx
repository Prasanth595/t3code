// Linked-artifact check: three real blocks (KPI group, area chart, kanban) plus a Kobra badge and a
// Tabler icon, every import served by the shared runtime. Example data.
import { useState } from "react";
import { KpiGroup, KpiGroupItem, KpiGroupValue } from "@nofun/ui/kpi-group";
import { KpiLabel, KpiTrend, KpiValue } from "@nofun/ui/kpi";
import {
  ChartArea,
  ChartAreaHeader,
  ChartAreaHeading,
  ChartAreaLegend,
  ChartAreaPlot,
  ChartAreaTitle,
} from "@nofun/ui/chart-area";
import {
  Kanban,
  KanbanCard,
  KanbanCardTitle,
  KanbanColumn,
  KanbanColumnBody,
  KanbanColumnCount,
  KanbanColumnHeader,
  KanbanColumnTitle,
} from "@nofun/ui/kanban";
import { Badge } from "@nofun/kobra/badge";
import { IconBolt } from "@tabler/icons-react";

const WEEKS = ["W33", "W34", "W35", "W36", "W37", "W38", "W39", "W40"].map((week, i) => ({
  week,
  storefront: 22000 + i * 1600 + (i % 3) * 900,
  wholesale: 9000 + i * 700,
}));
const SERIES = [
  { key: "storefront", label: "Storefront" },
  { key: "wholesale", label: "Wholesale", color: "chart-3" },
];
const COLUMNS = [
  { id: "todo", title: "To do" },
  { id: "doing", title: "Printing" },
  { id: "done", title: "Shipped" },
];
const CARDS: Record<string, string> = {
  a: "Restock bone heavyweight tee",
  b: "Proof lime ringer art",
  c: "Pack 40 wholesale hoodies",
  d: "Photograph five-panel cap",
  e: "Ship tote pre-orders",
};

export default function App() {
  const [board, setBoard] = useState<Record<string, string[]>>({
    todo: ["a", "b"],
    doing: ["c"],
    done: ["d", "e"],
  });
  return (
    <div className="flex flex-col gap-8">
      <p className="text-sm text-muted-foreground">Example data</p>
      <KpiGroup>
        <KpiGroupItem>
          <KpiLabel>Revenue</KpiLabel>
          <KpiGroupValue>
            <KpiValue value={48210} format="currency" maximumFractionDigits={0} />
            <KpiTrend value={12.4} />
          </KpiGroupValue>
        </KpiGroupItem>
        <KpiGroupItem>
          <KpiLabel>Orders</KpiLabel>
          <KpiGroupValue>
            <KpiValue value={1284} />
            <KpiTrend value={6.1} />
          </KpiGroupValue>
        </KpiGroupItem>
        <KpiGroupItem>
          <KpiLabel>Refund rate</KpiLabel>
          <KpiGroupValue>
            <KpiValue value={0.021} format="percent" maximumFractionDigits={1} />
            <KpiTrend value={-0.4} invert />
          </KpiGroupValue>
        </KpiGroupItem>
      </KpiGroup>

      <ChartArea>
        <ChartAreaHeader>
          <ChartAreaHeading>
            <ChartAreaTitle>Weekly revenue</ChartAreaTitle>
          </ChartAreaHeading>
          <ChartAreaLegend series={SERIES} />
        </ChartAreaHeader>
        <ChartAreaPlot data={WEEKS} xKey="week" stacked series={SERIES} height={240} />
      </ChartArea>

      <section className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <IconBolt className="size-4" />
          <h2 className="text-lg font-semibold">Print queue</h2>
          <Badge variant="outline">{Object.values(board).flat().length} jobs</Badge>
        </div>
        <Kanban value={board} onValueChange={setBoard} aria-label="Print queue" role="group">
          {COLUMNS.map((column) => (
            <KanbanColumn key={column.id} id={column.id} label={column.title}>
              <KanbanColumnHeader>
                <KanbanColumnTitle>{column.title}</KanbanColumnTitle>
                <KanbanColumnCount />
              </KanbanColumnHeader>
              <KanbanColumnBody>
                {board[column.id]!.map((id) => (
                  <KanbanCard key={id} id={id} label={CARDS[id]!}>
                    <KanbanCardTitle>{CARDS[id]}</KanbanCardTitle>
                  </KanbanCard>
                ))}
              </KanbanColumnBody>
            </KanbanColumn>
          ))}
        </Kanban>
      </section>
    </div>
  );
}

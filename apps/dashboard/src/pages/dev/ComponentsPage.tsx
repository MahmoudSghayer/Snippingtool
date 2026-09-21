import {
  AreaChart,
  BarChart,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Checkbox,
  ChartCard,
  CopyField,
  DataTable,
  DateRangePicker,
  defaultDateRange,
  DiffViewer,
  DonutChart,
  Drawer,
  EmptyState,
  FormField,
  Input,
  KpiGrid,
  LineChart,
  Modal,
  PageHeader,
  PasswordInput,
  Select,
  Skeleton,
  Sparkline,
  StatTile,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
  toast,
  Tooltip,
  type ColumnDef,
  type DateRange,
} from '@sl/ui';
import { useState } from 'react';

interface DemoRow {
  id: string;
  name: string;
  value: number;
}

const demoRows: DemoRow[] = [
  { id: '1', name: 'Alpha', value: 120 },
  { id: '2', name: 'Bravo', value: 84 },
  { id: '3', name: 'Charlie', value: 240 },
];

const demoColumns: ColumnDef<DemoRow, unknown>[] = [
  { accessorKey: 'name', header: 'Name' },
  { accessorKey: 'value', header: 'Value' },
];

const chartData = [
  { bucket: 'Mon', value: 120, alt: 80 },
  { bucket: 'Tue', value: 190, alt: 110 },
  { bucket: 'Wed', value: 150, alt: 95 },
  { bucket: 'Thu', value: 220, alt: 140 },
];

/** Dev-only route (`/dev/components`, gated by `import.meta.env.DEV` in
 * router.tsx) that renders every `@sl/ui` component for visual QA — the
 * substitute for a full Storybook instance (PHASE 10 deliverable #1). */
export function ComponentsPage() {
  const [modalOpen, setModalOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [range, setRange] = useState<DateRange>(defaultDateRange('7d'));
  const [switchOn, setSwitchOn] = useState(true);
  const [checked, setChecked] = useState<boolean | 'indeterminate'>(true);

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-8 p-6">
      <PageHeader
        title="Component gallery"
        description="Every @sl/ui component, for visual QA. Dev-only."
      />

      <Section title="Buttons">
        <div className="flex flex-wrap gap-2">
          <Button>Primary</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="outline">Outline</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="destructive">Destructive</Button>
          <Button loading>Loading</Button>
          <Button disabled>Disabled</Button>
        </div>
      </Section>

      <Section title="Badges">
        <div className="flex flex-wrap gap-2">
          <Badge>Neutral</Badge>
          <Badge tone="positive">Positive</Badge>
          <Badge tone="negative">Negative</Badge>
          <Badge tone="warning">Warning</Badge>
          <Badge tone="accent">Accent</Badge>
        </div>
      </Section>

      <Section title="Form fields">
        <div className="grid max-w-md grid-cols-1 gap-4">
          <FormField label="Email" htmlFor="demo-email">
            <Input id="demo-email" placeholder="you@example.com" />
          </FormField>
          <FormField label="Password" htmlFor="demo-password">
            <PasswordInput id="demo-password" />
          </FormField>
          <FormField label="Notes" htmlFor="demo-notes">
            <Textarea id="demo-notes" rows={3} />
          </FormField>
          <FormField label="Plan" htmlFor="demo-plan">
            <Select
              options={[
                { value: 'basic', label: 'Basic' },
                { value: 'pro', label: 'Pro' },
              ]}
              placeholder="Choose a plan"
            />
          </FormField>
          <div className="flex items-center gap-2">
            <Switch checked={switchOn} onCheckedChange={setSwitchOn} aria-label="Demo switch" />
            <span className="text-sm text-ink">Switch</span>
          </div>
          <div className="flex items-center gap-2">
            <Checkbox checked={checked} onCheckedChange={setChecked} aria-label="Demo checkbox" />
            <span className="text-sm text-ink">Checkbox</span>
          </div>
        </div>
      </Section>

      <Section title="Stat tiles">
        <KpiGrid>
          <StatTile
            label="Net profit"
            value="1,240,000"
            delta={0.124}
            deltaLabel="vs prior 7d"
            sparkline={<Sparkline data={[3, 5, 4, 8, 7, 9, 12]} />}
          />
          <StatTile label="Error rate" value="2.1%" delta={0.5} invertDeltaTone />
          <StatTile label="Active users" value="482" />
          <StatTile label="Churn" value="3.2%" delta={-0.1} />
        </KpiGrid>
      </Section>

      <Section title="Charts">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <ChartCard title="Line" height={200}>
            <LineChart
              data={chartData}
              xKey="bucket"
              series={[{ key: 'value', label: 'Value', colorIndex: 0 }]}
            />
          </ChartCard>
          <ChartCard title="Area" height={200}>
            <AreaChart
              data={chartData}
              xKey="bucket"
              series={[{ key: 'value', label: 'Value', colorIndex: 1 }]}
            />
          </ChartCard>
          <ChartCard title="Bar" height={200}>
            <BarChart
              data={chartData}
              xKey="bucket"
              series={[
                { key: 'value', label: 'A', colorIndex: 0 },
                { key: 'alt', label: 'B', colorIndex: 2 },
              ]}
            />
          </ChartCard>
          <ChartCard title="Donut" height={200}>
            <DonutChart
              data={[
                { key: 'a', label: 'A', value: 40 },
                { key: 'b', label: 'B', value: 60 },
              ]}
              centerLabel="total"
              centerValue="100"
            />
          </ChartCard>
        </div>
      </Section>

      <Section title="Date range picker">
        <DateRangePicker value={range} onChange={setRange} />
      </Section>

      <Section title="Data table">
        <DataTable
          columns={demoColumns}
          data={demoRows}
          getRowId={(row) => row.id}
          enableColumnVisibility
        />
      </Section>

      <Section title="Empty / loading / error">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Card>
            <CardContent className="pt-5">
              <EmptyState title="Nothing here" description="An empty state example." />
            </CardContent>
          </Card>
          <Card>
            <CardContent className="flex flex-col gap-2 pt-5">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-2/3" />
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-5">
              <Tooltip content="A tooltip">
                <Button variant="outline">Hover me</Button>
              </Tooltip>
            </CardContent>
          </Card>
        </div>
      </Section>

      <Section title="Diff viewer">
        <DiffViewer
          before={{ status: 'active', plan: 'pro' }}
          after={{ status: 'suspended', plan: 'pro' }}
        />
      </Section>

      <Section title="Copy field">
        <CopyField label="License key" value="SL-9F2K-4H3M-2X7Q-88ZZ" className="max-w-sm" />
      </Section>

      <Section title="Modal, Drawer, Toast">
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => setModalOpen(true)}>Open modal</Button>
          <Button variant="outline" onClick={() => setDrawerOpen(true)}>
            Open drawer
          </Button>
          <Button variant="outline" onClick={() => toast.success('This is a toast')}>
            Fire toast
          </Button>
        </div>
        <Modal
          open={modalOpen}
          onOpenChange={setModalOpen}
          title="Example modal"
          footer={<Button onClick={() => setModalOpen(false)}>Close</Button>}
        >
          <p className="text-sm text-ink-2">Modal body content.</p>
        </Modal>
        <Drawer open={drawerOpen} onOpenChange={setDrawerOpen} title="Example drawer">
          <p className="text-sm text-ink-2">Drawer body content.</p>
        </Drawer>
      </Section>

      <Section title="Tabs">
        <Tabs defaultValue="one">
          <TabsList>
            <TabsTrigger value="one">One</TabsTrigger>
            <TabsTrigger value="two">Two</TabsTrigger>
          </TabsList>
          <TabsContent value="one">Tab one content.</TabsContent>
          <TabsContent value="two">Tab two content.</TabsContent>
        </Tabs>
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

export default ComponentsPage;

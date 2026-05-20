import { Component, OnDestroy, OnInit, computed, signal } from '@angular/core';

type VisualStatus = 'baseline' | 'clean' | 'changed' | 'accepted';
type DashboardPage = 'dashboard' | 'history';

type VisualBaseline = {
  readonly id: string;
  readonly name: string;
  readonly source: string;
  readonly targetUrl: string;
  readonly browser: string;
  readonly viewport: string;
  readonly status: VisualStatus;
  readonly generatedAt: string | null;
  readonly path?: string;
  readonly baselineImageUrl: string;
  readonly actualImageUrl: string | null;
  readonly diffImageUrl: string | null;
  readonly snapshotPath: string;
  readonly actualPath: string | null;
  readonly diffPath: string | null;
  readonly errorContextPath: string | null;
  readonly summary?: string;
  readonly description?: string;
};

type VisualManifest = {
  readonly revisionId?: string;
  readonly uuid?: string;
  readonly status?: VisualStatus;
  readonly createdAt?: string;
  readonly acceptedAt?: string;
  readonly label?: string;
  readonly totalPages?: number;
  readonly changedPages?: number;
  readonly cleanPages?: number;
  readonly items: readonly VisualBaseline[];
};

type VisualRevision = {
  readonly id: string;
  readonly uuid?: string;
  readonly label: string;
  readonly status: VisualStatus;
  readonly createdAt: string;
  readonly acceptedAt?: string;
  readonly targetUrl: string;
  readonly totalPages: number;
  readonly changedPages: number;
  readonly cleanPages: number;
  readonly manifestUrl: string;
};

type VisualHistory = {
  readonly latestRevisionId?: string;
  readonly latestManifestUrl?: string;
  readonly revisions: readonly VisualRevision[];
};

type AcceptRevisionResponse = {
  readonly message: string;
  readonly history: VisualHistory;
  readonly manifest: VisualManifest;
};

type VisualScanResponse = {
  readonly message: string;
  readonly exitCode: number;
  readonly output: string;
  readonly history: VisualHistory;
  readonly manifest: VisualManifest;
};

const DEFAULT_BASELINES: readonly VisualBaseline[] = [
  {
    id: 'home-page',
    name: 'Home Page',
    source: 'Visual Test Sample',
    targetUrl: 'https://visual-test-sample.vercel.app/',
    browser: 'Chromium',
    viewport: '1440 x 900',
    status: 'baseline',
    generatedAt: null,
    baselineImageUrl: '/assets/baselines/visual-test-sample/home-page-chromium-darwin.png',
    actualImageUrl: null,
    diffImageUrl: null,
    snapshotPath: 'tests/visual-test-sample.spec.ts-snapshots/home-page-chromium-darwin.png',
    actualPath: null,
    diffPath: null,
    errorContextPath: null,
  },
];

@Component({
  selector: 'app-root',
  standalone: true,
  templateUrl: './app.component.html',
  styleUrl: './app.component.css',
})
export class AppComponent implements OnInit, OnDestroy {
  readonly currentPage = signal<DashboardPage>(this.pageFromLocation());
  readonly baselines = signal(DEFAULT_BASELINES);
  readonly selectedBaselineId = signal(DEFAULT_BASELINES[0].id);
  readonly revisions = signal<readonly VisualRevision[]>([]);
  readonly selectedRevisionId = signal('');
  readonly revisionManifests = signal<Record<string, VisualManifest>>({});
  readonly unavailableArtifacts = signal<Record<string, true>>({});
  readonly acceptingRevision = signal(false);
  readonly acceptingAll = signal(false);
  readonly acceptMessage = signal<string | null>(null);
  readonly acceptError = signal<string | null>(null);
  readonly scanning = signal(false);
  readonly scanMessage = signal<string | null>(null);
  readonly scanError = signal<string | null>(null);
  readonly imageVersion = signal('');

  readonly selectedBaseline = computed(() => {
    return this.baselines().find((baseline) => baseline.id === this.selectedBaselineId()) ?? DEFAULT_BASELINES[0];
  });

  readonly selectedRevision = computed(() => {
    return this.revisions().find((revision) => revision.id === this.selectedRevisionId()) ?? null;
  });

  readonly pageEyebrow = computed(() => {
    return this.currentPage() === 'history' ? 'Reports / History' : 'Visual Regression';
  });

  readonly pageHeading = computed(() => {
    return this.currentPage() === 'history' ? 'Visual Reports and Snapshot History' : 'Screenshot Comparison';
  });

  private readonly handlePopState = (): void => {
    this.currentPage.set(this.pageFromLocation());
  };

  async ngOnInit(): Promise<void> {
    window.addEventListener('popstate', this.handlePopState);

    try {
      const history = await this.fetchJson<VisualHistory>('/visual-results/history.json');

      if (history?.revisions.length) {
        this.revisions.set(history.revisions);
        await this.selectRevision(history.latestRevisionId ?? history.revisions[0].id);
        return;
      }

      const manifest = await this.fetchJson<VisualManifest>('/visual-results/manifest.json');
      this.applyManifest(manifest);
    } catch {
      this.baselines.set(DEFAULT_BASELINES);
    }
  }

  ngOnDestroy(): void {
    window.removeEventListener('popstate', this.handlePopState);
  }

  goToDashboard(): void {
    this.navigateTo('/', 'dashboard');
  }

  goToHistory(): void {
    this.navigateTo('/reports/history', 'history');
  }

  async selectRevision(revisionId: string): Promise<void> {
    const revision = this.revisions().find((item) => item.id === revisionId);

    if (!revision) {
      return;
    }

    this.selectedRevisionId.set(revisionId);

    const cachedManifest = this.revisionManifests()[revisionId];
    const manifest = cachedManifest ?? await this.fetchJson<VisualManifest>(revision.manifestUrl);

    if (manifest) {
      this.revisionManifests.update((manifests) => ({
        ...manifests,
        [revisionId]: manifest,
      }));
      this.applyManifest(manifest);
    }
  }

  selectBaseline(baselineId: string): void {
    this.selectedBaselineId.set(baselineId);
  }

  statusLabel(status: VisualStatus): string {
    if (status === 'accepted') {
      return 'Accepted as baseline';
    }

    if (status === 'changed') {
      return 'Difference detected';
    }

    if (status === 'clean') {
      return 'Matches baseline';
    }

    return 'Baseline';
  }

  reportTitle(baseline: VisualBaseline): string {
    if (baseline.summary) {
      return baseline.summary;
    }

    if (baseline.status === 'changed') {
      return `${baseline.name} changed from the approved baseline.`;
    }

    if (baseline.status === 'clean') {
      return `${baseline.name} matches the approved baseline.`;
    }

    return `${baseline.name} baseline is ready.`;
  }

  reportDescription(baseline: VisualBaseline): string {
    if (baseline.description) {
      return baseline.description;
    }

    if (baseline.status === 'changed') {
      return 'The current page does not look like the original screenshot. Review the current image and the highlighted diff beside the baseline.';
    }

    if (baseline.status === 'clean') {
      return 'The latest visual check did not find layout, color, spacing, or text rendering changes for this page.';
    }

    return 'This screenshot is the original approved image used for future comparisons.';
  }

  errorLocation(baseline: VisualBaseline): string {
    return baseline.errorContextPath ?? baseline.diffPath ?? baseline.actualPath ?? baseline.snapshotPath;
  }

  locationLabel(baseline: VisualBaseline): string {
    return baseline.status === 'changed' ? 'Error Details' : 'Reference File';
  }

  cardTitle(baseline: VisualBaseline): string {
    if (baseline.path === '/' || !baseline.path) {
      return 'Home Page';
    }

    return baseline.name;
  }

  cardDescription(baseline: VisualBaseline): string {
    const pagePath = baseline.path ?? new URL(baseline.targetUrl).pathname;
    const pageReference = baseline.path === '/' || !baseline.path ? baseline.name : pagePath || '/';
    return `${pageReference} · ${this.statusLabel(baseline.status)}`;
  }

  revisionSummary(revision: VisualRevision): string {
    return `${revision.changedPages} changed · ${revision.cleanPages} unchanged · ${revision.totalPages} total`;
  }

  revisionDisplayLabel(revision: VisualRevision): string {
    return `${this.revisionDateTime(revision)} - ${this.statusLabel(revision.status)}`;
  }

  revisionClass(revision: VisualRevision): string {
    if (revision.status === 'changed') {
      return 'is-changed';
    }

    if (revision.status === 'accepted') {
      return 'is-accepted';
    }

    return 'is-clean';
  }

  canAcceptRevision(): boolean {
    return this.canAcceptSelectedPage();
  }

  canAcceptSelectedPage(): boolean {
    const revision = this.selectedRevision();
    const baseline = this.selectedBaseline();
    return Boolean(revision && baseline.status === 'changed');
  }

  canAcceptAllRevision(): boolean {
    const revision = this.selectedRevision();
    return Boolean(revision && revision.changedPages > 0);
  }

  approvalHint(): string {
    const revision = this.selectedRevision();

    if (!revision) {
      return 'Select a visual revision before accepting a baseline.';
    }

    if (revision.status === 'accepted') {
      return 'This run has already replaced the approved baseline screenshots.';
    }

    if (revision.status !== 'changed') {
      return 'This run already matches the approved baseline.';
    }

    return 'Accept one page at a time, or accept all changed pages after confirmation.';
  }

  imageSrc(imageUrl: string | null): string {
    if (!imageUrl) {
      return '';
    }

    const version = this.imageVersion();
    if (!version) {
      return imageUrl;
    }

    return `${imageUrl}${imageUrl.includes('?') ? '&' : '?'}v=${version}`;
  }

  revisionUUID(revision: VisualRevision | null): string {
    return revision?.uuid ?? revision?.id ?? 'Unavailable';
  }

  revisionDateTime(revision: VisualRevision | null): string {
    if (!revision) {
      return 'Unavailable';
    }

    return new Intl.DateTimeFormat('en', {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(revision.createdAt));
  }

  historySnapshotPath(revision: VisualRevision | null, baseline: VisualBaseline): string {
    return baseline.actualPath ?? `public${revision?.manifestUrl ?? '/visual-results/manifest.json'}`;
  }

  diffSnapshotPath(baseline: VisualBaseline): string {
    return baseline.diffPath ?? 'No diff snapshot for this page.';
  }

  async acceptSelectedPage(): Promise<void> {
    const revision = this.selectedRevision();
    const baseline = this.selectedBaseline();

    if (!revision || !this.canAcceptSelectedPage() || this.acceptingRevision()) {
      return;
    }

    this.acceptingRevision.set(true);
    this.acceptMessage.set(null);
    this.acceptError.set(null);

    try {
      const response = await fetch(`/api/visual-revisions/${encodeURIComponent(revision.id)}/items/${encodeURIComponent(baseline.id)}/accept`, {
        method: 'POST',
      });
      const payload = await response.json() as AcceptRevisionResponse | { error?: string };

      if (!response.ok) {
        throw new Error('error' in payload && payload.error ? payload.error : 'Could not accept this visual revision.');
      }

      this.applyAcceptResponse(payload as AcceptRevisionResponse, revision.id);
    } catch (error) {
      this.acceptError.set(error instanceof Error ? error.message : 'Could not accept this page.');
    } finally {
      this.acceptingRevision.set(false);
    }
  }

  async acceptAllChangedPages(): Promise<void> {
    const revision = this.selectedRevision();

    if (!revision || !this.canAcceptAllRevision() || this.acceptingAll()) {
      return;
    }

    const confirmed = window.confirm(`Accept all ${revision.changedPages} changed page(s) as the new baseline? This will overwrite the approved baseline screenshots.`);
    if (!confirmed) {
      return;
    }

    this.acceptingAll.set(true);
    this.acceptMessage.set(null);
    this.acceptError.set(null);

    try {
      const response = await fetch(`/api/visual-revisions/${encodeURIComponent(revision.id)}/accept-all`, {
        method: 'POST',
      });
      const payload = await response.json() as AcceptRevisionResponse | { error?: string };

      if (!response.ok) {
        throw new Error('error' in payload && payload.error ? payload.error : 'Could not accept all changed pages.');
      }

      this.applyAcceptResponse(payload as AcceptRevisionResponse, revision.id);
    } catch (error) {
      this.acceptError.set(error instanceof Error ? error.message : 'Could not accept all changed pages.');
    } finally {
      this.acceptingAll.set(false);
    }
  }

  async runVisualScan(): Promise<void> {
    if (this.scanning()) {
      return;
    }

    this.scanning.set(true);
    this.scanMessage.set(null);
    this.scanError.set(null);
    this.acceptMessage.set(null);
    this.acceptError.set(null);

    try {
      const response = await fetch('/api/visual-scan', { method: 'POST' });
      const payload = await response.json() as VisualScanResponse | { error?: string };

      if (!response.ok) {
        throw new Error('error' in payload && payload.error ? payload.error : 'Could not run the visual scan.');
      }

      const scanPayload = payload as VisualScanResponse;
      this.revisions.set(scanPayload.history.revisions);
      this.revisionManifests.update((manifests) => ({
        ...manifests,
        [scanPayload.manifest.revisionId ?? scanPayload.history.latestRevisionId ?? 'latest']: scanPayload.manifest,
      }));
      this.selectedRevisionId.set(scanPayload.manifest.revisionId ?? scanPayload.history.latestRevisionId ?? '');
      this.applyManifest(scanPayload.manifest);
      this.scanMessage.set(scanPayload.message);
      this.imageVersion.set(String(Date.now()));
    } catch (error) {
      this.scanError.set(error instanceof Error ? error.message : 'Could not run the visual scan.');
    } finally {
      this.scanning.set(false);
    }
  }

  artifactAvailable(imageUrl: string | null): imageUrl is string {
    return Boolean(imageUrl && !this.unavailableArtifacts()[imageUrl]);
  }

  markArtifactUnavailable(imageUrl: string): void {
    this.unavailableArtifacts.update((artifacts) => ({
      ...artifacts,
      [imageUrl]: true,
    }));
  }

  private async fetchJson<T>(url: string): Promise<T | null> {
    const response = await fetch(url, { cache: 'no-store' });

    if (!response.ok) {
      return null;
    }

    return await response.json() as T;
  }

  private applyManifest(manifest: VisualManifest | null): void {
    if (!manifest?.items.length) {
      return;
    }

    this.baselines.set(manifest.items);

    const selectedId = this.selectedBaselineId();
    const nextSelectedBaseline = manifest.items.some((item) => item.id === selectedId)
      ? selectedId
      : manifest.items[0].id;

    this.selectedBaselineId.set(nextSelectedBaseline);
  }

  private applyAcceptResponse(payload: AcceptRevisionResponse, fallbackRevisionId: string): void {
    this.revisions.set(payload.history.revisions);
    this.revisionManifests.update((manifests) => ({
      ...manifests,
      [payload.manifest.revisionId ?? fallbackRevisionId]: payload.manifest,
    }));
    this.applyManifest(payload.manifest);
    this.acceptMessage.set(payload.message);
    this.imageVersion.set(String(Date.now()));
  }

  private navigateTo(path: string, page: DashboardPage): void {
    if (window.location.pathname !== path) {
      window.history.pushState({}, '', path);
    }

    this.currentPage.set(page);
  }

  private pageFromLocation(): DashboardPage {
    if (typeof window === 'undefined') {
      return 'dashboard';
    }

    return window.location.pathname.startsWith('/reports/history') ? 'history' : 'dashboard';
  }
}

import { Component, OnDestroy, OnInit, computed, signal } from '@angular/core';

type VisualStatus = 'baseline' | 'clean' | 'changed' | 'accepted';
type DashboardPage = 'projects' | 'dashboard' | 'snapshots';
type VisualJob = 'visual-scan' | 'section-scan' | 'refresh-sections' | 'update-baselines';

type VisualScanRunOptions = {
  readonly retryWhenBusy?: boolean;
};

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

type VisualProjectStats = {
  readonly latestStatus: VisualStatus;
  readonly changedPages: number;
  readonly totalSections: number;
  readonly lastScanTime?: string;
  readonly totalRevisions: number;
};

type VisualProject = {
  readonly id: string;
  readonly name: string;
  readonly targetUrl: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly stats: VisualProjectStats;
};

type ProjectsResponse = {
  readonly defaultProjectId: string;
  readonly projects: readonly VisualProject[];
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

type ScanProgress = {
  readonly running: boolean;
  readonly message: string;
  readonly output: string;
  readonly updatedAt?: string;
};

type SectionResponse = {
  readonly message: string;
  readonly section: VisualBaseline;
  readonly manifest: VisualManifest;
};

type SectionRefreshResponse = {
  readonly message: string;
  readonly manifest: VisualManifest;
};

type SectionDeleteResponse = {
  readonly message: string;
  readonly manifest: VisualManifest;
};

@Component({
  selector: 'app-root',
  standalone: true,
  templateUrl: './app.component.html',
  styleUrl: './app.component.css',
})
export class AppComponent implements OnInit, OnDestroy {
  readonly currentPage = signal<DashboardPage>(this.pageFromLocation());
  readonly projects = signal<readonly VisualProject[]>([]);
  readonly defaultProjectId = signal('');
  readonly selectedProjectId = signal(this.projectIdFromLocation());
  readonly loadingProjects = signal(true);
  readonly creatingProject = signal(false);
  readonly projectMessage = signal<string | null>(null);
  readonly projectError = signal<string | null>(null);
  readonly baselines = signal<readonly VisualBaseline[]>([]);
  readonly selectedBaselineId = signal('');
  readonly revisions = signal<readonly VisualRevision[]>([]);
  readonly selectedRevisionId = signal('');
  readonly revisionManifests = signal<Record<string, VisualManifest>>({});
  readonly unavailableArtifacts = signal<Record<string, true>>({});
  readonly acceptingRevision = signal(false);
  readonly acceptingAll = signal(false);
  readonly acceptMessage = signal<string | null>(null);
  readonly acceptError = signal<string | null>(null);
  readonly scanning = signal(false);
  readonly runningJob = signal<VisualJob | null>(null);
  readonly scanMessage = signal<string | null>(null);
  readonly scanError = signal<string | null>(null);
  readonly scanProgress = signal<ScanProgress | null>(null);
  readonly cancelingScan = signal(false);
  readonly sectionFormOpen = signal(false);
  readonly editingSections = signal(false);
  readonly addingSection = signal(false);
  readonly updatingSection = signal(false);
  readonly updatingBaseline = signal(false);
  readonly removingSectionId = signal('');
  readonly selectedSectionImageName = signal('');
  readonly selectedBaselineImageName = signal('');
  readonly sectionMessage = signal<string | null>(null);
  readonly sectionError = signal<string | null>(null);
  readonly sectionSettingsId = signal('');
  readonly reportOpen = signal(true);
  readonly imageVersion = signal('');

  readonly selectedBaseline = computed<VisualBaseline | null>(() => {
    return this.baselines().find((baseline) => baseline.id === this.selectedBaselineId()) ?? this.baselines().at(0) ?? null;
  });

  readonly selectedProject = computed(() => {
    return this.projects().find((project) => project.id === this.selectedProjectId()) ?? null;
  });

  readonly selectedRevision = computed(() => {
    return this.revisions().find((revision) => revision.id === this.selectedRevisionId()) ?? null;
  });

  readonly sectionSettingsBaseline = computed(() => {
    const settingsId = this.sectionSettingsId();
    return settingsId ? this.baselines().find((baseline) => baseline.id === settingsId) ?? null : null;
  });

  readonly pageEyebrow = computed(() => {
    if (this.currentPage() === 'snapshots') {
      return 'Snapshots';
    }

    return `${this.selectedProject()?.name ?? 'Project'} · Visual Regression`;
  });

  readonly pageHeading = computed(() => {
    return this.currentPage() === 'snapshots' ? 'Snapshots' : '';
  });

  readonly refreshingSections = computed(() => this.runningJob() === 'refresh-sections');
  readonly updatingGeneratedBaselines = computed(() => this.runningJob() === 'update-baselines');

  private scanAbortController: AbortController | null = null;
  private scanProgressTimer: number | null = null;

  private readonly handlePopState = (): void => {
    this.currentPage.set(this.pageFromLocation());
    const projectId = this.projectIdFromLocation();
    if (projectId) {
      this.selectedProjectId.set(projectId);
    }
    if (this.currentPage() !== 'projects') {
      void this.loadProjectVisualData();
    }
  };

  async ngOnInit(): Promise<void> {
    window.addEventListener('popstate', this.handlePopState);
    await this.loadProjects();

    if (this.currentPage() === 'projects') {
      return;
    }

    await this.loadProjectVisualData();
  }

  ngOnDestroy(): void {
    this.scanAbortController?.abort();
    this.stopScanProgressPolling();
    window.removeEventListener('popstate', this.handlePopState);
  }

  async loadProjects(): Promise<void> {
    this.loadingProjects.set(true);
    this.projectError.set(null);

    try {
      const response = await this.fetchJson<ProjectsResponse>('/api/projects');
      if (!response) {
        throw new Error('Could not load visual projects.');
      }
      const projects = response?.projects ?? [];
      this.projects.set(projects);
      this.defaultProjectId.set(response?.defaultProjectId ?? projects[0]?.id ?? '');

      if (!this.selectedProjectId()) {
        this.selectedProjectId.set(this.defaultProjectId());
      }
    } catch (error) {
      this.projectError.set(error instanceof Error ? error.message : 'Could not load visual projects.');
    } finally {
      this.loadingProjects.set(false);
    }
  }

  async createProject(event: SubmitEvent): Promise<void> {
    event.preventDefault();

    if (this.creatingProject()) {
      return;
    }

    const form = event.currentTarget as HTMLFormElement;
    const formData = new FormData(form);
    const name = formData.get('name')?.toString().trim() ?? '';
    const targetUrl = formData.get('targetUrl')?.toString().trim() ?? '';

    if (!name || !targetUrl) {
      this.projectError.set('Project name and target URL are required.');
      return;
    }

    this.creatingProject.set(true);
    this.projectMessage.set(null);
    this.projectError.set(null);

    try {
      const response = await fetch('/api/projects', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name, targetUrl }),
      });
      const payload = await response.json() as VisualProject | { error?: string };

      if (!response.ok) {
        throw new Error('error' in payload && payload.error ? payload.error : 'Could not create this project.');
      }

      await this.loadProjects();
      const project = payload as VisualProject;
      this.projectMessage.set(`${project.name} created. Starting scan.`);
      form.reset();
      await this.openProject(project.id);
      await this.runVisualScan({ retryWhenBusy: true });
    } catch (error) {
      this.projectError.set(error instanceof Error ? error.message : 'Could not create this project.');
    } finally {
      this.creatingProject.set(false);
    }
  }

  private resetVisualState(): void {
    this.baselines.set([]);
    this.selectedBaselineId.set('');
    this.revisions.set([]);
    this.selectedRevisionId.set('');
    this.revisionManifests.set({});
    this.unavailableArtifacts.set({});
    this.acceptMessage.set(null);
    this.acceptError.set(null);
    this.scanMessage.set(null);
    this.scanError.set(null);
    this.sectionMessage.set(null);
    this.sectionError.set(null);
    this.sectionSettingsId.set('');
    this.selectedSectionImageName.set('');
    this.selectedBaselineImageName.set('');
  }

  async loadProjectVisualData(): Promise<void> {
    this.resetVisualState();
    try {
      const projectId = this.selectedProjectId() || this.defaultProjectId();
      if (!projectId) {
        return;
      }

      const history = await this.fetchJson<VisualHistory>(`/visual-results/${encodeURIComponent(projectId)}/history.json`);

      if (history?.revisions.length) {
        this.revisions.set(history.revisions);
        await this.selectRevision(history.latestRevisionId ?? history.revisions[0].id);
        await this.mergeAvailableSections();
        return;
      }

      const manifest = await this.fetchJson<VisualManifest>(`/visual-results/${encodeURIComponent(projectId)}/manifest.json`);
      this.applyManifest(manifest);
      await this.mergeAvailableSections();
    } catch {
      await this.mergeAvailableSections();
    }
  }

  goToDashboard(): void {
    this.navigateTo('/', 'projects');
    void this.loadProjects();
  }

  async openProject(projectId: string): Promise<void> {
    this.selectedProjectId.set(projectId);
    this.navigateTo(`/workspace${this.projectQuery()}`, 'dashboard');
    await this.loadProjectVisualData();
  }

  async goToWorkspace(): Promise<void> {
    this.navigateTo(`/workspace${this.projectQuery()}`, 'dashboard');
    await this.loadProjectVisualData();
  }

  goToSnapshots(): void {
    this.navigateTo(`/snapshots${this.projectQuery()}`, 'snapshots');
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

  openSectionSettings(baselineId: string): void {
    this.selectedBaselineId.set(baselineId);
    this.sectionSettingsId.set(baselineId);
    this.selectedBaselineImageName.set('');
    this.sectionMessage.set(null);
    this.sectionError.set(null);
  }

  closeSectionSettings(): void {
    this.sectionSettingsId.set('');
    this.selectedBaselineImageName.set('');
  }

  toggleReport(): void {
    this.reportOpen.update((isOpen) => !isOpen);
  }

  toggleSectionEditing(): void {
    const isEditing = !this.editingSections();
    this.editingSections.set(isEditing);
    this.sectionMessage.set(null);
    this.sectionError.set(null);
    if (!isEditing) {
      this.sectionFormOpen.set(false);
      this.closeSectionSettings();
    }
  }

  toggleSectionForm(): void {
    const isOpen = !this.sectionFormOpen();
    this.sectionFormOpen.set(isOpen);
    this.sectionMessage.set(null);
    this.sectionError.set(null);
    if (!isOpen) {
      this.selectedSectionImageName.set('');
    }
  }

  selectSectionUpload(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.selectedSectionImageName.set(input.files?.[0]?.name ?? '');
  }

  selectBaselineUpload(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.selectedBaselineImageName.set(input.files?.[0]?.name ?? '');
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

  projectLastScan(project: VisualProject): string {
    if (!project.stats.lastScanTime) {
      return 'Never';
    }

    return new Intl.DateTimeFormat('en', {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(project.stats.lastScanTime));
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

  targetName(baseline: VisualBaseline): string {
    if (baseline.source.trim()) {
      return baseline.source;
    }

    try {
      return new URL(baseline.targetUrl).hostname.replace(/^www\./, '');
    } catch {
      return baseline.name;
    }
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
    return Boolean(revision && baseline?.status === 'changed');
  }

  canAcceptAllRevision(): boolean {
    const revision = this.selectedRevision();
    return Boolean(revision && revision.changedPages > 0);
  }

  approvalHint(): string {
    const revision = this.selectedRevision();

    if (!revision) {
      return 'Select a visual snapshot before accepting a baseline.';
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
    return baseline.actualPath ?? `public${revision?.manifestUrl ?? `/visual-results/${this.selectedProjectId()}/manifest.json`}`;
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
      if (!baseline) {
        return;
      }

      const response = await fetch(this.projectScopedUrl(`/api/visual-revisions/${encodeURIComponent(revision.id)}/items/${encodeURIComponent(baseline.id)}/accept`), {
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
      const response = await fetch(this.projectScopedUrl(`/api/visual-revisions/${encodeURIComponent(revision.id)}/accept-all`), {
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

  async runVisualScan(options: VisualScanRunOptions = {}): Promise<void> {
    await this.runVisualScanRequest(
      this.projectScopedUrl('/api/visual-scan'),
      false,
      'visual-scan',
      options,
    );
  }

  async runSelectedSectionScan(): Promise<void> {
    const baseline = this.selectedBaseline();
    if (!baseline) {
      return;
    }
    await this.runVisualScanRequest(
      this.projectScopedUrl(`/api/visual-sections/${encodeURIComponent(baseline.id)}/scan`),
      true,
      'section-scan',
    );
  }

  async refreshSections(): Promise<void> {
    await this.runSectionRefreshRequest(false);
  }

  async updateAllGeneratedBaselines(): Promise<void> {
    const confirmed = window.confirm('Update all generated baselines? This will overwrite approved baseline screenshots for discovered sections.');
    if (!confirmed) {
      return;
    }

    await this.runSectionRefreshRequest(true);
  }

  jobEyebrow(): string {
    const job = this.runningJob();
    return job === 'refresh-sections' || job === 'update-baselines' ? 'Sections' : 'Visual Scan';
  }

  jobTitle(): string {
    const job = this.runningJob();

    if (this.cancelingScan()) {
      if (job === 'refresh-sections') {
        return 'Canceling refresh...';
      }
      if (job === 'update-baselines') {
        return 'Canceling baseline update...';
      }
      return 'Canceling scan...';
    }

    if (job === 'refresh-sections') {
      return 'Refreshing sections...';
    }
    if (job === 'update-baselines') {
      return 'Updating generated baselines...';
    }

    return 'Comparing screenshots...';
  }

  jobDescription(): string {
    const progress = this.scanProgress();

    if (progress?.message) {
      return progress.message;
    }

    const job = this.runningJob();

    if (this.cancelingScan()) {
      return 'Stopping the running job and returning control.';
    }
    if (job === 'refresh-sections') {
      return 'Discovering target pages, registering sections, and capturing missing baselines.';
    }
    if (job === 'update-baselines') {
      return 'Discovering target pages and replacing generated baseline screenshots.';
    }

    return 'Capturing current pages, checking pixels, and preparing the visual report.';
  }

  scanProgressLines(): readonly string[] {
    const output = this.scanProgress()?.output ?? '';
    if (!output.trim()) {
      return [];
    }

    return output
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-8);
  }

  private async runVisualScanRequest(
    endpoint: string,
    replaceSelectedSectionOnly = false,
    job: VisualJob = 'visual-scan',
    options: VisualScanRunOptions = {},
  ): Promise<void> {
    if (this.scanning()) {
      return;
    }

    const controller = new AbortController();
    this.scanAbortController = controller;
    this.runningJob.set(job);
    this.scanning.set(true);
    this.cancelingScan.set(false);
    this.scanMessage.set(null);
    this.scanError.set(null);
    this.scanProgress.set(null);
    this.acceptMessage.set(null);
    this.acceptError.set(null);
    this.sectionMessage.set(null);
    this.sectionError.set(null);
    this.startScanProgressPolling();

    try {
      const maxAttempts = options.retryWhenBusy ? 30 : 1;

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const response = await fetch(endpoint, {
          method: 'POST',
          signal: controller.signal,
        });
        const payload = await response.json() as VisualScanResponse | { error?: string };
        const busy = response.status === 409
          && 'error' in payload
          && payload.error === 'A visual scan is already running.';

        if (busy && options.retryWhenBusy && attempt < maxAttempts) {
          this.scanMessage.set('Another visual scan is running. This project will scan next.');
          await this.waitForRetry(3000, controller.signal);
          continue;
        }

        if (!response.ok) {
          const fallback = busy
            ? 'Another visual scan is still running. Start this project scan when the current scan finishes.'
            : 'Could not run the visual scan.';
          throw new Error('error' in payload && payload.error && !busy ? payload.error : fallback);
        }

        const scanPayload = payload as VisualScanResponse;
        this.revisions.set(scanPayload.history.revisions);
        this.revisionManifests.update((manifests) => ({
          ...manifests,
          [scanPayload.manifest.revisionId ?? scanPayload.history.latestRevisionId ?? 'latest']: scanPayload.manifest,
        }));
        this.selectedRevisionId.set(scanPayload.manifest.revisionId ?? scanPayload.history.latestRevisionId ?? '');
        if (replaceSelectedSectionOnly && scanPayload.manifest.items.length === 1) {
          this.replaceSection(scanPayload.manifest.items[0]);
        } else {
          this.applyManifest(scanPayload.manifest);
        }
        await this.mergeAvailableSections();
        this.scanMessage.set(scanPayload.message);
        this.imageVersion.set(String(Date.now()));
        await this.loadProjects();
        return;
      }
    } catch (error) {
      if (this.isAbortError(error)) {
        this.scanMessage.set(job === 'section-scan' ? 'Section scan canceled.' : 'Visual scan canceled.');
      } else {
        this.scanError.set(error instanceof Error ? error.message : 'Could not run the visual scan.');
      }
    } finally {
      if (this.scanAbortController === controller) {
        this.scanAbortController = null;
      }
      this.stopScanProgressPolling();
      this.cancelingScan.set(false);
      this.runningJob.set(null);
      this.scanning.set(false);
    }
  }

  private waitForRetry(milliseconds: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new DOMException('Aborted', 'AbortError'));
        return;
      }

      const timeout = window.setTimeout(resolve, milliseconds);
      signal.addEventListener('abort', () => {
        window.clearTimeout(timeout);
        reject(new DOMException('Aborted', 'AbortError'));
      }, { once: true });
    });
  }

  private async runSectionRefreshRequest(update: boolean): Promise<void> {
    if (this.scanning()) {
      return;
    }

    const controller = new AbortController();
    const job: VisualJob = update ? 'update-baselines' : 'refresh-sections';
    const endpoint = this.projectScopedUrl('/api/visual-sections/crawl', {
      ...(update ? { update: 'true' } : {}),
    });

    this.scanAbortController = controller;
    this.runningJob.set(job);
    this.scanning.set(true);
    this.cancelingScan.set(false);
    this.scanMessage.set(null);
    this.scanError.set(null);
    this.scanProgress.set(null);
    this.acceptMessage.set(null);
    this.acceptError.set(null);
    this.sectionMessage.set(null);
    this.sectionError.set(null);
    this.startScanProgressPolling();

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        signal: controller.signal,
      });
      const payload = await response.json() as SectionRefreshResponse | { error?: string };

      if (!response.ok) {
        throw new Error('error' in payload && payload.error ? payload.error : 'Could not refresh sections.');
      }

      const refreshPayload = payload as SectionRefreshResponse;
      this.applyManifest(refreshPayload.manifest);
      this.sectionMessage.set(refreshPayload.message);
      this.sectionError.set(null);
      this.imageVersion.set(String(Date.now()));
      await this.loadProjects();
    } catch (error) {
      if (this.isAbortError(error)) {
        this.sectionMessage.set(update ? 'Baseline update canceled.' : 'Section refresh canceled.');
      } else {
        this.sectionError.set(error instanceof Error ? error.message : 'Could not refresh sections.');
      }
    } finally {
      if (this.scanAbortController === controller) {
        this.scanAbortController = null;
      }
      this.stopScanProgressPolling();
      this.cancelingScan.set(false);
      this.runningJob.set(null);
      this.scanning.set(false);
    }
  }

  cancelVisualScan(): void {
    if (!this.scanning() || this.cancelingScan()) {
      return;
    }

    this.cancelingScan.set(true);
    this.scanAbortController?.abort();
  }

  private startScanProgressPolling(): void {
    this.stopScanProgressPolling();
    void this.pollScanProgress();
    this.scanProgressTimer = window.setInterval(() => {
      void this.pollScanProgress();
    }, 1000);
  }

  private stopScanProgressPolling(): void {
    if (this.scanProgressTimer === null) {
      return;
    }

    window.clearInterval(this.scanProgressTimer);
    this.scanProgressTimer = null;
  }

  private async pollScanProgress(): Promise<void> {
    try {
      const response = await fetch('/api/visual-scan/status');
      if (!response.ok) {
        return;
      }

      this.scanProgress.set(await response.json() as ScanProgress);
    } catch {
      // Progress is secondary to the scan request itself.
    }
  }

  async addSection(event: SubmitEvent): Promise<void> {
    event.preventDefault();

    if (this.addingSection()) {
      return;
    }

    const form = event.currentTarget as HTMLFormElement;
    const formData = new FormData(form);

    this.addingSection.set(true);
    this.sectionMessage.set(null);
    this.sectionError.set(null);

    try {
      const response = await fetch(this.projectScopedUrl('/api/visual-sections'), {
        method: 'POST',
        body: formData,
      });
      const payload = await response.json() as SectionResponse | { error?: string };

      if (!response.ok) {
        throw new Error('error' in payload && payload.error ? payload.error : 'Could not add this section.');
      }

      const sectionPayload = payload as SectionResponse;
      this.mergeSection(sectionPayload.section);
      this.selectedBaselineId.set(sectionPayload.section.id);
      this.sectionMessage.set(sectionPayload.message);
      this.sectionError.set(null);
      this.selectedSectionImageName.set('');
      this.sectionFormOpen.set(false);
      this.imageVersion.set(String(Date.now()));
      await this.loadProjects();
      form.reset();
    } catch (error) {
      this.sectionError.set(error instanceof Error ? error.message : 'Could not add this section.');
    } finally {
      this.addingSection.set(false);
    }
  }

  async updateSelectedBaselineImage(event: SubmitEvent): Promise<void> {
    event.preventDefault();

    if (this.updatingBaseline()) {
      return;
    }

    const form = event.currentTarget as HTMLFormElement;
    const formData = new FormData(form);
    await this.uploadSelectedBaselineImage(formData);
    form.reset();
  }

  async updateSelectedSectionDetails(event: SubmitEvent): Promise<void> {
    event.preventDefault();

    const baseline = this.sectionSettingsBaseline();
    if (!baseline || this.updatingSection()) {
      return;
    }

    const form = event.currentTarget as HTMLFormElement;
    const formData = new FormData(form);
    const name = formData.get('name')?.toString().trim() ?? '';

    if (!name) {
      this.sectionError.set('Section name is required.');
      return;
    }

    this.updatingSection.set(true);
    this.sectionMessage.set(null);
    this.sectionError.set(null);

    try {
      const response = await fetch(this.projectScopedUrl(`/api/visual-sections/${encodeURIComponent(baseline.id)}`), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name }),
      });
      const payload = await response.json() as SectionResponse | { error?: string };

      if (!response.ok) {
        throw new Error('error' in payload && payload.error ? payload.error : 'Could not rename this section.');
      }

      const sectionPayload = payload as SectionResponse;
      this.mergeSection(sectionPayload.section);
      this.selectedBaselineId.set(sectionPayload.section.id);
      this.sectionMessage.set(sectionPayload.message);
      this.sectionError.set(null);
    } catch (error) {
      this.sectionError.set(error instanceof Error ? error.message : 'Could not rename this section.');
    } finally {
      this.updatingSection.set(false);
    }
  }

  async overrideSelectedBaselineImage(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];

    if (!file || this.updatingBaseline()) {
      return;
    }

    const formData = new FormData();
    formData.append('baselineImage', file);
    await this.uploadSelectedBaselineImage(formData);
    input.value = '';
  }

  async removeSection(sectionId: string, sectionName: string): Promise<void> {
    if (this.removingSectionId()) {
      return;
    }

    const confirmed = window.confirm(`Remove "${sectionName}" from visual sections? This does not change existing visual history.`);
    if (!confirmed) {
      return;
    }

    this.removingSectionId.set(sectionId);
    this.sectionMessage.set(null);
    this.sectionError.set(null);

    try {
      const response = await fetch(this.projectScopedUrl(`/api/visual-sections/${encodeURIComponent(sectionId)}`), {
        method: 'DELETE',
      });
      const payload = await response.json() as SectionDeleteResponse | { error?: string };

      if (!response.ok) {
        throw new Error('error' in payload && payload.error ? payload.error : 'Could not remove this section.');
      }

      const deletePayload = payload as SectionDeleteResponse;
      this.removeSectionFromState(sectionId);
      if (this.sectionSettingsId() === sectionId) {
        this.closeSectionSettings();
      }
      this.sectionMessage.set(deletePayload.message);
      this.imageVersion.set(String(Date.now()));
      await this.loadProjects();
    } catch (error) {
      this.sectionError.set(error instanceof Error ? error.message : 'Could not remove this section.');
    } finally {
      this.removingSectionId.set('');
    }
  }

  private async uploadSelectedBaselineImage(formData: FormData): Promise<void> {
    const baseline = this.selectedBaseline();
    if (!baseline || this.updatingBaseline()) {
      return;
    }

    this.updatingBaseline.set(true);
    this.sectionMessage.set(null);
    this.sectionError.set(null);

    try {
      const response = await fetch(this.projectScopedUrl(`/api/visual-sections/${encodeURIComponent(baseline.id)}/baseline`), {
        method: 'POST',
        body: formData,
      });
      const payload = await response.json() as SectionResponse | { error?: string };

      if (!response.ok) {
        throw new Error('error' in payload && payload.error ? payload.error : 'Could not update this baseline image.');
      }

      const sectionPayload = payload as SectionResponse;
      this.mergeSection(sectionPayload.section);
      this.selectedBaselineId.set(sectionPayload.section.id);
      this.sectionMessage.set(sectionPayload.message);
      this.selectedBaselineImageName.set('');
      this.imageVersion.set(String(Date.now()));
    } catch (error) {
      this.sectionError.set(error instanceof Error ? error.message : 'Could not update this baseline image.');
    } finally {
      this.updatingBaseline.set(false);
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

  private isAbortError(error: unknown): boolean {
    return typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError';
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
    void this.loadProjects();
  }

  private async mergeAvailableSections(): Promise<void> {
    const manifest = await this.fetchJson<VisualManifest>(this.projectScopedUrl('/api/visual-sections')).catch(() => null);
    if (!manifest?.items.length) {
      return;
    }

    this.baselines.update((baselines) => {
      const existingIds = new Set(baselines.map((baseline) => baseline.id));
      const missingSections = manifest.items.filter((section) => !existingIds.has(section.id));
      return missingSections.length ? [...baselines, ...missingSections] : baselines;
    });
  }

  private mergeSection(section: VisualBaseline): void {
    this.baselines.update((baselines) => {
      const sectionIndex = baselines.findIndex((baseline) => baseline.id === section.id);
      if (sectionIndex === -1) {
        return [...baselines, section];
      }

      return baselines.map((baseline, index) => index === sectionIndex
        ? {
            ...baseline,
            ...section,
            status: baseline.status,
            actualImageUrl: baseline.actualImageUrl,
            diffImageUrl: baseline.diffImageUrl,
            actualPath: baseline.actualPath,
            diffPath: baseline.diffPath,
            errorContextPath: baseline.errorContextPath,
          }
        : baseline);
    });
  }

  private replaceSection(section: VisualBaseline): void {
    this.baselines.update((baselines) => {
      const sectionIndex = baselines.findIndex((baseline) => baseline.id === section.id);
      if (sectionIndex === -1) {
        return [...baselines, section];
      }

      return baselines.map((baseline, index) => index === sectionIndex ? section : baseline);
    });
    this.selectedBaselineId.set(section.id);
  }

  private removeSectionFromState(sectionId: string): void {
    this.baselines.update((baselines) => {
      const remainingSections = baselines.filter((baseline) => baseline.id !== sectionId);
      return remainingSections.length ? remainingSections : baselines;
    });

    if (this.selectedBaselineId() === sectionId) {
      this.selectedBaselineId.set(this.baselines()[0]?.id ?? '');
    }
  }

  private navigateTo(path: string, page: DashboardPage): void {
    if (`${window.location.pathname}${window.location.search}` !== path) {
      window.history.pushState({}, '', path);
    }

    this.currentPage.set(page);
  }

  private pageFromLocation(): DashboardPage {
    if (typeof window === 'undefined') {
      return 'projects';
    }

    const path = window.location.pathname;
    if (path.startsWith('/snapshots') || path.startsWith('/reports/history')) {
      return 'snapshots';
    }
    if (path.startsWith('/workspace')) {
      return 'dashboard';
    }
    return 'projects';
  }

  private projectIdFromLocation(): string {
    if (typeof window === 'undefined') {
      return '';
    }

    return new URLSearchParams(window.location.search).get('project') ?? '';
  }

  private projectQuery(): string {
    const projectId = this.selectedProjectId() || this.defaultProjectId();
    return projectId ? `?project=${encodeURIComponent(projectId)}` : '';
  }

  private projectScopedUrl(path: string, extraParams?: Record<string, string>): string {
    const params = new URLSearchParams(extraParams);
    const projectId = this.selectedProjectId() || this.defaultProjectId();
    if (projectId) {
      params.set('project', projectId);
    }

    const query = params.toString();
    return query ? `${path}?${query}` : path;
  }
}

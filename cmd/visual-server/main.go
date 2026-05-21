package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
	"unicode"
)

type visualStatus string

const (
	statusBaseline visualStatus = "baseline"
	statusClean    visualStatus = "clean"
	statusChanged  visualStatus = "changed"
	statusAccepted visualStatus = "accepted"
)

const (
	defaultProjectID      = "visual-test-sample"
	defaultProjectName    = "Visual Test Sample"
	defaultTargetURL      = "https://visual-test-sample.vercel.app/"
	maxBaselineUploadSize = 20 << 20
)

type visualProjectRegistry struct {
	Version          int             `json:"version"`
	DefaultProjectID string          `json:"defaultProjectId"`
	Projects         []visualProject `json:"projects"`
}

type visualProject struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	TargetURL string `json:"targetUrl"`
	CreatedAt string `json:"createdAt,omitempty"`
	UpdatedAt string `json:"updatedAt,omitempty"`
}

type visualProjectStats struct {
	LatestStatus   visualStatus `json:"latestStatus"`
	ChangedPages   int          `json:"changedPages"`
	TotalSections  int          `json:"totalSections"`
	LastScanTime   string       `json:"lastScanTime,omitempty"`
	TotalRevisions int          `json:"totalRevisions"`
}

type visualProjectSummary struct {
	ID        string             `json:"id"`
	Name      string             `json:"name"`
	TargetURL string             `json:"targetUrl"`
	CreatedAt string             `json:"createdAt,omitempty"`
	UpdatedAt string             `json:"updatedAt,omitempty"`
	Stats     visualProjectStats `json:"stats"`
}

type projectsResponse struct {
	Version          int                    `json:"version"`
	DefaultProjectID string                 `json:"defaultProjectId"`
	Projects         []visualProjectSummary `json:"projects"`
}

type projectContext struct {
	Project         visualProject
	VisualPagesPath string
	SnapshotDir     string
	ResultsDir      string
}

type visualPagesManifest struct {
	Version     int          `json:"version"`
	TargetURL   string       `json:"targetUrl"`
	GeneratedAt string       `json:"generatedAt"`
	Pages       []visualPage `json:"pages"`
}

type visualAction struct {
	Type     string `json:"type"`
	Selector string `json:"selector"`
	Index    int    `json:"index,omitempty"`
	Text     string `json:"text,omitempty"`
	Label    string `json:"label,omitempty"`
}

type visualPage struct {
	ID               string         `json:"id"`
	Name             string         `json:"name"`
	Path             string         `json:"path"`
	URL              string         `json:"url"`
	SnapshotName     string         `json:"snapshotName"`
	BaselineFileName string         `json:"baselineFileName"`
	BaselineImageURL string         `json:"baselineImageUrl"`
	SnapshotPath     string         `json:"snapshotPath"`
	ManualBaseline   bool           `json:"manualBaseline,omitempty"`
	Actions          []visualAction `json:"actions,omitempty"`
}

type visualItem struct {
	ID               string         `json:"id"`
	Name             string         `json:"name"`
	Source           string         `json:"source"`
	TargetURL        string         `json:"targetUrl"`
	Browser          string         `json:"browser"`
	Viewport         string         `json:"viewport"`
	SnapshotName     string         `json:"snapshotName"`
	BaselineFileName string         `json:"baselineFileName"`
	BaselineImageURL string         `json:"baselineImageUrl"`
	SnapshotPath     string         `json:"snapshotPath"`
	Path             string         `json:"path"`
	URL              string         `json:"url"`
	Status           visualStatus   `json:"status"`
	GeneratedAt      string         `json:"generatedAt"`
	RevisionID       string         `json:"revisionId"`
	ActualImageURL   *string        `json:"actualImageUrl"`
	DiffImageURL     *string        `json:"diffImageUrl"`
	ActualPath       *string        `json:"actualPath"`
	DiffPath         *string        `json:"diffPath"`
	ErrorContextPath *string        `json:"errorContextPath"`
	Summary          string         `json:"summary"`
	Description      string         `json:"description"`
	Actions          []visualAction `json:"actions,omitempty"`
}

type revisionManifest struct {
	Version           int          `json:"version"`
	RevisionID        string       `json:"revisionId"`
	UUID              string       `json:"uuid,omitempty"`
	Status            visualStatus `json:"status"`
	CreatedAt         string       `json:"createdAt"`
	GeneratedAt       string       `json:"generatedAt"`
	AcceptedAt        *string      `json:"acceptedAt,omitempty"`
	Label             string       `json:"label"`
	TargetURL         string       `json:"targetUrl"`
	TotalPages        int          `json:"totalPages"`
	ChangedPages      int          `json:"changedPages"`
	CleanPages        int          `json:"cleanPages"`
	Items             []visualItem `json:"items"`
	LatestRevisionID  string       `json:"latestRevisionId,omitempty"`
	LatestManifestURL string       `json:"latestManifestUrl,omitempty"`
}

type revisionSummary struct {
	ID           string       `json:"id"`
	UUID         string       `json:"uuid,omitempty"`
	Label        string       `json:"label"`
	Status       visualStatus `json:"status"`
	CreatedAt    string       `json:"createdAt"`
	AcceptedAt   *string      `json:"acceptedAt,omitempty"`
	TargetURL    string       `json:"targetUrl"`
	TotalPages   int          `json:"totalPages"`
	ChangedPages int          `json:"changedPages"`
	CleanPages   int          `json:"cleanPages"`
	ManifestURL  string       `json:"manifestUrl"`
}

type visualHistory struct {
	Version           int               `json:"version"`
	GeneratedAt       string            `json:"generatedAt"`
	LatestRevisionID  string            `json:"latestRevisionId"`
	LatestManifestURL string            `json:"latestManifestUrl"`
	Revisions         []revisionSummary `json:"revisions"`
}

type acceptResponse struct {
	Message  string           `json:"message"`
	History  visualHistory    `json:"history"`
	Manifest revisionManifest `json:"manifest"`
}

type scanResponse struct {
	Message  string           `json:"message"`
	ExitCode int              `json:"exitCode"`
	Output   string           `json:"output"`
	History  visualHistory    `json:"history"`
	Manifest revisionManifest `json:"manifest"`
}

type scanPreview struct {
	ID         string `json:"id"`
	ProjectID  string `json:"projectId,omitempty"`
	Name       string `json:"name"`
	Kind       string `json:"kind"`
	ImageURL   string `json:"imageUrl"`
	CapturedAt string `json:"capturedAt"`
}

type scanStatusResponse struct {
	Running   bool          `json:"running"`
	Message   string        `json:"message"`
	Output    string        `json:"output"`
	Previews  []scanPreview `json:"previews"`
	UpdatedAt string        `json:"updatedAt,omitempty"`
}

type sectionResponse struct {
	Message  string           `json:"message"`
	Section  visualItem       `json:"section"`
	Manifest revisionManifest `json:"manifest"`
}

type sectionDeleteResponse struct {
	Message  string           `json:"message"`
	Manifest revisionManifest `json:"manifest"`
}

type sectionRefreshResponse struct {
	Message  string           `json:"message"`
	Output   string           `json:"output,omitempty"`
	Manifest revisionManifest `json:"manifest"`
}

type server struct {
	rootDir    string
	staticDir  string
	scanMu     sync.Mutex
	scanning   bool
	scanStatus scanStatusResponse
}

func main() {
	rootDir, err := os.Getwd()
	if err != nil {
		log.Fatal(err)
	}

	s := server{
		rootDir:   rootDir,
		staticDir: filepath.Join(rootDir, "dist", "ratchet", "browser"),
	}
	if _, err := s.ensureProjectRegistry(); err != nil {
		log.Fatal(err)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/api/health", s.handleHealth)
	mux.HandleFunc("/api/projects", s.handleProjects)
	mux.HandleFunc("/api/projects/", s.handleProject)
	mux.HandleFunc("/api/visual-scan/status", s.handleVisualScanStatus)
	mux.HandleFunc("/api/visual-scan", s.handleVisualScan)
	mux.HandleFunc("/api/visual-revisions/", s.handleVisualRevision)
	mux.HandleFunc("/api/visual-sections", s.handleVisualSections)
	mux.HandleFunc("/api/visual-sections/crawl", s.handleVisualSectionsCrawl)
	mux.HandleFunc("/api/visual-sections/", s.handleVisualSection)
	mux.HandleFunc("/visual-results/", s.handleVisualResults)
	mux.HandleFunc("/assets/baselines/", s.handleBaselineAsset)
	mux.HandleFunc("/", s.handleStatic)

	port := os.Getenv("PORT")
	if port == "" {
		port = "4300"
	}

	log.Printf("visual dashboard backend listening on http://127.0.0.1:%s", port)
	log.Fatal(http.ListenAndServe("127.0.0.1:"+port, withCORS(mux)))
}

func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")

		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}

		next.ServeHTTP(w, r)
	})
}

func (s server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s server) handleProjects(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		registry, err := s.ensureProjectRegistry()
		if err != nil {
			writeError(w, http.StatusBadRequest, "Could not read visual projects.")
			return
		}

		response, err := s.projectsResponse(registry)
		if err != nil {
			writeError(w, http.StatusBadRequest, "Could not read visual project stats.")
			return
		}

		writeJSON(w, http.StatusOK, response)
	case http.MethodPost:
		project, err := s.createProject(w, r)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}

		writeJSON(w, http.StatusOK, project)
	default:
		writeError(w, http.StatusMethodNotAllowed, "Only GET and POST are supported.")
	}
}

func (s server) handleProject(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "Only GET is supported.")
		return
	}

	projectID := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/projects/"), "/")
	if projectID == "" || strings.Contains(projectID, "/") {
		writeError(w, http.StatusBadRequest, "The selected visual project is invalid.")
		return
	}

	project, err := s.projectSummary(projectID)
	if err != nil {
		writeError(w, http.StatusNotFound, err.Error())
		return
	}

	writeJSON(w, http.StatusOK, project)
}

func (s *server) handleVisualSections(w http.ResponseWriter, r *http.Request) {
	project, err := s.projectFromRequest(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	switch r.Method {
	case http.MethodGet:
		manifest, err := s.readVisualPagesManifest(project)
		if err != nil {
			writeError(w, http.StatusBadRequest, "Could not read visual sections.")
			return
		}

		writeJSON(w, http.StatusOK, s.visualPagesToManifest(project, manifest))
	case http.MethodPost:
		response, err := s.addVisualSection(w, r, project)
		if err != nil {
			log.Printf("add visual section failed: %v", err)
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}

		writeJSON(w, http.StatusOK, response)
	default:
		writeError(w, http.StatusMethodNotAllowed, "Only GET and POST are supported.")
	}
}

func (s *server) handleVisualSectionsCrawl(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "Only POST is supported.")
		return
	}

	project, err := s.projectFromRequest(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	update, err := readSectionRefreshRequest(w, r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	response, err := s.runVisualSectionsRefresh(r.Context(), project, update)
	if err != nil {
		log.Printf("refresh visual sections failed: %v", err)
		if errors.Is(err, errScanAlreadyRunning) {
			writeError(w, http.StatusConflict, err.Error())
			return
		}
		if errors.Is(err, context.Canceled) {
			return
		}
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	writeJSON(w, http.StatusOK, response)
}

func (s *server) handleVisualSection(w http.ResponseWriter, r *http.Request) {
	project, err := s.projectFromRequest(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	pathSuffix := strings.TrimPrefix(r.URL.Path, "/api/visual-sections/")
	parts := strings.Split(strings.Trim(pathSuffix, "/"), "/")

	if r.Method == http.MethodDelete {
		if len(parts) != 1 || parts[0] == "" || strings.Contains(parts[0], "..") {
			writeError(w, http.StatusBadRequest, "Use DELETE /api/visual-sections/{sectionID}.")
			return
		}

		response, err := s.deleteVisualSection(project, parts[0])
		if err != nil {
			log.Printf("delete visual section failed: %v", err)
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}

		writeJSON(w, http.StatusOK, response)
		return
	}

	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "Only POST and DELETE are supported.")
		return
	}

	if len(parts) == 1 && parts[0] != "" && !strings.Contains(parts[0], "..") {
		response, err := s.updateVisualSectionDetails(w, r, project, parts[0])
		if err != nil {
			log.Printf("update visual section failed: %v", err)
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}

		writeJSON(w, http.StatusOK, response)
		return
	}

	if len(parts) != 2 || parts[0] == "" || strings.Contains(parts[0], "..") {
		writeError(w, http.StatusBadRequest, "Use /api/visual-sections/{sectionID}/baseline or /api/visual-sections/{sectionID}/scan.")
		return
	}

	switch parts[1] {
	case "baseline":
		response, err := s.updateVisualSectionBaseline(w, r, project, parts[0])
		if err != nil {
			log.Printf("update section baseline failed: %v", err)
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}

		writeJSON(w, http.StatusOK, response)
	case "scan":
		response, err := s.runVisualScan(r.Context(), project, parts[0])
		if err != nil {
			log.Printf("section visual scan failed: %v", err)
			if errors.Is(err, errScanAlreadyRunning) {
				writeError(w, http.StatusConflict, err.Error())
				return
			}
			if errors.Is(err, context.Canceled) {
				return
			}
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}

		writeJSON(w, http.StatusOK, response)
	default:
		writeError(w, http.StatusBadRequest, "Use /api/visual-sections/{sectionID}/baseline or /api/visual-sections/{sectionID}/scan.")
	}
}

func (s *server) handleVisualScan(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "Only POST is supported.")
		return
	}

	project, err := s.projectFromRequest(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	response, err := s.runVisualScan(r.Context(), project, "")
	if err != nil {
		log.Printf("visual scan failed: %v", err)
		if errors.Is(err, errScanAlreadyRunning) {
			writeError(w, http.StatusConflict, err.Error())
			return
		}
		if errors.Is(err, context.Canceled) {
			return
		}
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	writeJSON(w, http.StatusOK, response)
}

func (s *server) handleVisualScanStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "Only GET is supported.")
		return
	}

	writeJSON(w, http.StatusOK, s.visualJobStatus())
}

func (s server) handleVisualRevision(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "Only POST is supported.")
		return
	}

	project, err := s.projectFromRequest(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	pathSuffix := strings.TrimPrefix(r.URL.Path, "/api/visual-revisions/")
	parts := strings.Split(strings.Trim(pathSuffix, "/"), "/")
	if len(parts) < 2 || parts[0] == "" || strings.Contains(parts[0], "..") {
		writeError(w, http.StatusBadRequest, "The selected visual revision is invalid.")
		return
	}

	revisionID := parts[0]
	var response acceptResponse

	switch {
	case len(parts) == 2 && parts[1] == "accept-all":
		response, err = s.acceptAllRevisionItems(project, revisionID)
	case len(parts) == 4 && parts[1] == "items" && parts[3] == "accept" && parts[2] != "":
		response, err = s.acceptOneRevisionItem(project, revisionID, parts[2])
	default:
		writeError(w, http.StatusBadRequest, "Use a page-specific accept endpoint or accept-all.")
		return
	}

	if err != nil {
		log.Printf("accept revision failed: %v", err)
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	writeJSON(w, http.StatusOK, response)
}

func (s server) handleVisualResults(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		writeError(w, http.StatusMethodNotAllowed, "Only GET is supported.")
		return
	}

	resultsRoot := filepath.Join(s.rootDir, "public", "visual-results")
	relativePath := filepath.Clean(strings.TrimPrefix(r.URL.Path, "/visual-results/"))
	if relativePath == "." {
		http.NotFound(w, r)
		return
	}

	resultPath := filepath.Join(resultsRoot, filepath.FromSlash(relativePath))
	if isInside(resultsRoot, resultPath) {
		if info, err := os.Stat(resultPath); err == nil && !info.IsDir() {
			http.ServeFile(w, r, resultPath)
			return
		}
	}

	parts := strings.Split(filepath.ToSlash(relativePath), "/")
	if len(parts) != 2 || !validProjectID(parts[0]) {
		http.NotFound(w, r)
		return
	}

	if _, err := s.projectByID(parts[0]); err != nil {
		http.NotFound(w, r)
		return
	}

	switch parts[1] {
	case "history.json":
		writeJSON(w, http.StatusOK, visualHistory{
			Version:   1,
			Revisions: []revisionSummary{},
		})
	case "manifest.json":
		writeJSON(w, http.StatusOK, revisionManifest{
			Version:      1,
			Status:       statusBaseline,
			TotalPages:   0,
			ChangedPages: 0,
			CleanPages:   0,
			Items:        []visualItem{},
		})
	default:
		http.NotFound(w, r)
	}
}

func (s server) handleBaselineAsset(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		writeError(w, http.StatusMethodNotAllowed, "Only GET is supported.")
		return
	}

	pathSuffix := strings.TrimPrefix(r.URL.Path, "/assets/baselines/")
	parts := strings.SplitN(strings.Trim(pathSuffix, "/"), "/", 2)
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" || strings.Contains(parts[0], "..") || strings.Contains(parts[1], "..") {
		http.NotFound(w, r)
		return
	}

	projectID := parts[0]
	fileName := filepath.Base(parts[1])
	if fileName != parts[1] {
		http.NotFound(w, r)
		return
	}

	snapshotPath := filepath.Join(s.projectSnapshotDir(projectID), fileName)
	if !isInside(s.projectSnapshotDir(projectID), snapshotPath) {
		http.NotFound(w, r)
		return
	}

	http.ServeFile(w, r, snapshotPath)
}

func (s server) handleStatic(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		writeError(w, http.StatusMethodNotAllowed, "Only GET is supported.")
		return
	}

	cleanPath := filepath.Clean(strings.TrimPrefix(r.URL.Path, "/"))
	if cleanPath == "." {
		cleanPath = "index.html"
	}

	targetPath := filepath.Join(s.staticDir, cleanPath)
	if isInside(s.staticDir, targetPath) {
		if info, err := os.Stat(targetPath); err == nil && !info.IsDir() {
			http.ServeFile(w, r, targetPath)
			return
		}
	}

	http.ServeFile(w, r, filepath.Join(s.staticDir, "index.html"))
}

var errScanAlreadyRunning = errors.New("A visual scan is already running.")

const scanPreviewOutputPrefix = "[ratchet-preview] "

func (s *server) runVisualScan(ctx context.Context, project projectContext, sectionID string) (scanResponse, error) {
	if err := s.beginVisualJob(fmt.Sprintf("Starting visual scan for %s.", project.Project.Name)); err != nil {
		return scanResponse{}, err
	}
	defer s.finishVisualJob()

	commandArgs := []string{"run", "test:visual", "--", "--project=" + project.Project.ID}
	if sectionID != "" {
		commandArgs = append(commandArgs, "--section="+sectionID)
	}
	command := exec.CommandContext(ctx, "npm", commandArgs...)
	command.Dir = s.rootDir
	output, err := s.runCommandWithProgress(command)
	exitCode := 0

	if err != nil {
		if errors.Is(ctx.Err(), context.Canceled) {
			return scanResponse{}, context.Canceled
		}

		var exitError *exec.ExitError
		if errors.As(err, &exitError) {
			exitCode = exitError.ExitCode()
		} else {
			return scanResponse{}, fmt.Errorf("Could not run the visual scan.")
		}
	}

	history, err := readJSON[visualHistory](filepath.Join(project.ResultsDir, "history.json"))
	if err != nil {
		return scanResponse{}, fmt.Errorf("The visual scan finished, but the revision history could not be read.")
	}

	manifest, err := readJSON[revisionManifest](filepath.Join(project.ResultsDir, "manifest.json"))
	if err != nil {
		return scanResponse{}, fmt.Errorf("The visual scan finished, but the latest visual revision could not be read.")
	}

	message := "Visual scan completed and matches the approved baseline."
	if exitCode != 0 {
		message = "Visual scan completed and found differences that need review."
	}
	if sectionID != "" && exitCode == 0 {
		message = "Section scan completed and matches the approved baseline."
	} else if sectionID != "" {
		message = "Section scan completed and found differences that need review."
	}

	return scanResponse{
		Message:  message,
		ExitCode: exitCode,
		Output:   output,
		History:  history,
		Manifest: manifest,
	}, nil
}

func (s *server) runVisualSectionsRefresh(ctx context.Context, project projectContext, update bool) (sectionRefreshResponse, error) {
	if err := s.beginVisualJob(fmt.Sprintf("Refreshing sections for %s.", project.Project.Name)); err != nil {
		return sectionRefreshResponse{}, err
	}
	defer s.finishVisualJob()

	commandArgs := []string{"scripts/crawl-visual-baselines.mjs", "--project=" + project.Project.ID}
	if update {
		commandArgs = append(commandArgs, "--update")
	}
	command := exec.CommandContext(ctx, "node", commandArgs...)
	command.Dir = s.rootDir
	output, err := s.runCommandWithProgress(command)

	if err != nil {
		if errors.Is(ctx.Err(), context.Canceled) {
			return sectionRefreshResponse{}, context.Canceled
		}
		if output != "" {
			log.Printf("visual section refresh output:\n%s", output)
		}
		if update {
			return sectionRefreshResponse{}, fmt.Errorf("Could not update generated baselines.")
		}
		return sectionRefreshResponse{}, fmt.Errorf("Could not refresh visual sections.")
	}

	pagesManifest, err := s.readVisualPagesManifest(project)
	if err != nil {
		return sectionRefreshResponse{}, fmt.Errorf("Visual sections were refreshed, but the updated manifest could not be read.")
	}

	message := "Sections refreshed. New sections were added and missing baselines were captured."
	if update {
		message = "Generated baselines were updated for discovered sections."
	}

	return sectionRefreshResponse{
		Message:  message,
		Output:   output,
		Manifest: s.visualPagesToManifest(project, pagesManifest),
	}, nil
}

func (s *server) beginVisualJob(message string) error {
	s.scanMu.Lock()
	defer s.scanMu.Unlock()

	if s.scanning {
		return errScanAlreadyRunning
	}
	s.scanning = true
	s.scanStatus = scanStatusResponse{
		Running:   true,
		Message:   message,
		Output:    "",
		Previews:  []scanPreview{},
		UpdatedAt: time.Now().UTC().Format(time.RFC3339Nano),
	}
	return nil
}

func (s *server) finishVisualJob() {
	s.scanMu.Lock()
	s.scanning = false
	s.scanStatus.Running = false
	s.scanStatus.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	s.scanMu.Unlock()
}

func (s *server) visualJobStatus() scanStatusResponse {
	s.scanMu.Lock()
	defer s.scanMu.Unlock()

	status := s.scanStatus
	status.Previews = append([]scanPreview(nil), s.scanStatus.Previews...)
	return status
}

func (s *server) appendVisualJobOutput(line string) {
	cleanLine := strings.TrimSpace(stripTerminalControls(line))
	if cleanLine == "" {
		return
	}

	if strings.HasPrefix(cleanLine, scanPreviewOutputPrefix) {
		var preview scanPreview
		payload := strings.TrimPrefix(cleanLine, scanPreviewOutputPrefix)
		if err := json.Unmarshal([]byte(payload), &preview); err == nil {
			s.appendVisualJobPreview(preview)
		}
		return
	}

	s.scanMu.Lock()
	defer s.scanMu.Unlock()

	const maxOutputBytes = 12000
	if s.scanStatus.Output == "" {
		s.scanStatus.Output = cleanLine
	} else {
		s.scanStatus.Output += "\n" + cleanLine
	}
	if len(s.scanStatus.Output) > maxOutputBytes {
		s.scanStatus.Output = s.scanStatus.Output[len(s.scanStatus.Output)-maxOutputBytes:]
		if firstNewline := strings.IndexByte(s.scanStatus.Output, '\n'); firstNewline >= 0 {
			s.scanStatus.Output = s.scanStatus.Output[firstNewline+1:]
		}
	}

	s.scanStatus.Message = cleanLine
	s.scanStatus.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
}

func (s *server) appendVisualJobPreview(preview scanPreview) {
	if preview.ID == "" || preview.ImageURL == "" {
		return
	}
	if preview.Kind == "" {
		preview.Kind = "current"
	}
	if preview.CapturedAt == "" {
		preview.CapturedAt = time.Now().UTC().Format(time.RFC3339Nano)
	}

	s.scanMu.Lock()
	defer s.scanMu.Unlock()

	replaceIndex := -1
	for index, existing := range s.scanStatus.Previews {
		if existing.ProjectID == preview.ProjectID && existing.ID == preview.ID && existing.Kind == preview.Kind {
			replaceIndex = index
			break
		}
	}

	if replaceIndex >= 0 {
		s.scanStatus.Previews[replaceIndex] = preview
	} else {
		const maxPreviewItems = 80
		s.scanStatus.Previews = append(s.scanStatus.Previews, preview)
		if len(s.scanStatus.Previews) > maxPreviewItems {
			s.scanStatus.Previews = s.scanStatus.Previews[len(s.scanStatus.Previews)-maxPreviewItems:]
		}
	}

	kind := strings.TrimSpace(preview.Kind)
	if kind == "" {
		kind = "screenshot"
	}
	name := strings.TrimSpace(preview.Name)
	if name == "" {
		name = preview.ID
	}
	s.scanStatus.Message = fmt.Sprintf("Captured %s result: %s", kind, name)
	s.scanStatus.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
}

func (s *server) runCommandWithProgress(command *exec.Cmd) (string, error) {
	stdout, err := command.StdoutPipe()
	if err != nil {
		return "", err
	}
	stderr, err := command.StderrPipe()
	if err != nil {
		return "", err
	}

	var outputMu sync.Mutex
	var output strings.Builder
	recordLine := func(line string) {
		outputMu.Lock()
		output.WriteString(line)
		output.WriteByte('\n')
		outputMu.Unlock()
		s.appendVisualJobOutput(line)
	}
	readPipe := func(reader io.Reader, done chan<- struct{}) {
		defer close(done)
		scanner := bufio.NewScanner(reader)
		scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
		for scanner.Scan() {
			recordLine(scanner.Text())
		}
	}

	if err := command.Start(); err != nil {
		return "", err
	}

	stdoutDone := make(chan struct{})
	stderrDone := make(chan struct{})
	go readPipe(stdout, stdoutDone)
	go readPipe(stderr, stderrDone)

	err = command.Wait()
	<-stdoutDone
	<-stderrDone

	outputMu.Lock()
	result := output.String()
	outputMu.Unlock()

	return result, err
}

func stripTerminalControls(value string) string {
	var builder strings.Builder
	skippingEscape := false

	for _, character := range value {
		if skippingEscape {
			if (character >= 'A' && character <= 'Z') || (character >= 'a' && character <= 'z') {
				skippingEscape = false
			}
			continue
		}
		if character == '\x1b' {
			skippingEscape = true
			continue
		}
		if character < 32 && character != '\t' {
			continue
		}
		builder.WriteRune(character)
	}

	return builder.String()
}

func (s server) projectFromRequest(r *http.Request) (projectContext, error) {
	return s.projectByID(strings.TrimSpace(r.URL.Query().Get("project")))
}

func (s server) projectByID(projectID string) (projectContext, error) {
	registry, err := s.ensureProjectRegistry()
	if err != nil {
		return projectContext{}, fmt.Errorf("Could not read visual projects.")
	}

	if projectID == "" {
		projectID = registry.DefaultProjectID
	}
	if projectID == "" {
		projectID = defaultProjectID
	}
	if !validProjectID(projectID) {
		return projectContext{}, fmt.Errorf("The selected visual project is invalid.")
	}

	for _, project := range registry.Projects {
		if project.ID == projectID {
			return s.projectContext(project), nil
		}
	}

	return projectContext{}, fmt.Errorf("The selected visual project could not be found.")
}

func (s server) projectsResponse(registry visualProjectRegistry) (projectsResponse, error) {
	projects := make([]visualProjectSummary, 0, len(registry.Projects))
	for _, project := range registry.Projects {
		stats, err := s.projectStats(project)
		if err != nil {
			return projectsResponse{}, err
		}
		projects = append(projects, visualProjectSummary{
			ID:        project.ID,
			Name:      project.Name,
			TargetURL: project.TargetURL,
			CreatedAt: project.CreatedAt,
			UpdatedAt: project.UpdatedAt,
			Stats:     stats,
		})
	}

	return projectsResponse{
		Version:          registry.Version,
		DefaultProjectID: registry.DefaultProjectID,
		Projects:         projects,
	}, nil
}

func (s server) projectSummary(projectID string) (visualProjectSummary, error) {
	project, err := s.projectByID(projectID)
	if err != nil {
		return visualProjectSummary{}, err
	}

	stats, err := s.projectStats(project.Project)
	if err != nil {
		return visualProjectSummary{}, err
	}

	return visualProjectSummary{
		ID:        project.Project.ID,
		Name:      project.Project.Name,
		TargetURL: project.Project.TargetURL,
		CreatedAt: project.Project.CreatedAt,
		UpdatedAt: project.Project.UpdatedAt,
		Stats:     stats,
	}, nil
}

func (s server) projectStats(project visualProject) (visualProjectStats, error) {
	ctx := s.projectContext(project)
	stats := visualProjectStats{LatestStatus: statusBaseline}

	pagesManifest, err := s.readVisualPagesManifest(ctx)
	if err == nil {
		stats.TotalSections = len(pagesManifest.Pages)
	}

	history, err := readJSON[visualHistory](filepath.Join(ctx.ResultsDir, "history.json"))
	if err != nil {
		if latestManifest, manifestErr := readJSON[revisionManifest](filepath.Join(ctx.ResultsDir, "manifest.json")); manifestErr == nil {
			stats.LatestStatus = latestManifest.Status
			stats.ChangedPages = latestManifest.ChangedPages
			stats.LastScanTime = latestManifest.CreatedAt
			stats.TotalRevisions = 1
		}
		return stats, nil
	}

	stats.TotalRevisions = len(history.Revisions)
	latestRevisionID := history.LatestRevisionID
	for index, revision := range history.Revisions {
		if (latestRevisionID == "" && index == 0) || revision.ID == latestRevisionID {
			stats.LatestStatus = revision.Status
			stats.ChangedPages = revision.ChangedPages
			stats.LastScanTime = revision.CreatedAt
			break
		}
	}

	return stats, nil
}

func (s server) createProject(w http.ResponseWriter, r *http.Request) (visualProjectSummary, error) {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	defer r.Body.Close()

	var request struct {
		Name      string `json:"name"`
		TargetURL string `json:"targetUrl"`
	}
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		return visualProjectSummary{}, fmt.Errorf("Project details must be valid JSON.")
	}

	name := strings.TrimSpace(request.Name)
	targetURL := strings.TrimSpace(request.TargetURL)
	if name == "" {
		return visualProjectSummary{}, fmt.Errorf("Project name is required.")
	}
	if targetURL == "" {
		return visualProjectSummary{}, fmt.Errorf("Target URL is required.")
	}

	parsedURL, err := url.Parse(targetURL)
	if err != nil || !parsedURL.IsAbs() || (parsedURL.Scheme != "http" && parsedURL.Scheme != "https") {
		return visualProjectSummary{}, fmt.Errorf("Target URL must be an HTTP or HTTPS URL.")
	}
	parsedURL.Fragment = ""

	registry, err := s.ensureProjectRegistry()
	if err != nil {
		return visualProjectSummary{}, fmt.Errorf("Could not read visual projects.")
	}

	now := time.Now().UTC().Format(time.RFC3339Nano)
	project := visualProject{
		ID:        uniqueProjectID(slugProjectID(name), registry.Projects),
		Name:      name,
		TargetURL: parsedURL.String(),
		CreatedAt: now,
		UpdatedAt: now,
	}

	registry.Projects = append(registry.Projects, project)
	if registry.DefaultProjectID == "" {
		registry.DefaultProjectID = project.ID
	}
	if registry.Version == 0 {
		registry.Version = 1
	}

	if err := writeJSONFile(s.projectRegistryPath(), registry); err != nil {
		return visualProjectSummary{}, fmt.Errorf("Could not save the new visual project.")
	}
	if err := s.ensureProjectStorage(project); err != nil {
		return visualProjectSummary{}, fmt.Errorf("Could not initialize the new visual project.")
	}

	return s.projectSummary(project.ID)
}

func (s server) ensureProjectRegistry() (visualProjectRegistry, error) {
	registryPath := s.projectRegistryPath()
	registry, err := readJSON[visualProjectRegistry](registryPath)
	shouldWrite := false
	now := time.Now().UTC().Format(time.RFC3339Nano)

	if err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			return visualProjectRegistry{}, err
		}

		legacyManifest, _ := s.readLegacyVisualPagesManifest()
		generatedAt := legacyManifest.GeneratedAt
		if generatedAt == "" {
			generatedAt = now
		}
		targetURL := legacyManifest.TargetURL
		if targetURL == "" {
			targetURL = defaultTargetURL
		}

		registry = visualProjectRegistry{
			Version:          1,
			DefaultProjectID: defaultProjectID,
			Projects: []visualProject{{
				ID:        defaultProjectID,
				Name:      defaultProjectName,
				TargetURL: targetURL,
				CreatedAt: generatedAt,
				UpdatedAt: generatedAt,
			}},
		}
		shouldWrite = true
	}

	if registry.Version == 0 {
		registry.Version = 1
		shouldWrite = true
	}
	if registry.DefaultProjectID == "" && len(registry.Projects) > 0 {
		registry.DefaultProjectID = registry.Projects[0].ID
		shouldWrite = true
	}

	hasDefaultProject := false
	for index := range registry.Projects {
		project := &registry.Projects[index]
		if project.ID == defaultProjectID {
			hasDefaultProject = true
		}
		if project.Name == "" {
			project.Name = project.ID
			shouldWrite = true
		}
		if project.TargetURL == "" {
			project.TargetURL = defaultTargetURL
			shouldWrite = true
		}
		if project.CreatedAt == "" {
			project.CreatedAt = now
			shouldWrite = true
		}
		if project.UpdatedAt == "" {
			project.UpdatedAt = project.CreatedAt
			shouldWrite = true
		}
	}

	if !hasDefaultProject {
		legacyManifest, _ := s.readLegacyVisualPagesManifest()
		generatedAt := legacyManifest.GeneratedAt
		if generatedAt == "" {
			generatedAt = now
		}
		targetURL := legacyManifest.TargetURL
		if targetURL == "" {
			targetURL = defaultTargetURL
		}
		registry.Projects = append([]visualProject{{
			ID:        defaultProjectID,
			Name:      defaultProjectName,
			TargetURL: targetURL,
			CreatedAt: generatedAt,
			UpdatedAt: generatedAt,
		}}, registry.Projects...)
		if registry.DefaultProjectID == "" {
			registry.DefaultProjectID = defaultProjectID
		}
		shouldWrite = true
	}

	if shouldWrite {
		if err := writeJSONFile(registryPath, registry); err != nil {
			return visualProjectRegistry{}, err
		}
	}

	for _, project := range registry.Projects {
		if err := s.ensureProjectStorage(project); err != nil {
			return visualProjectRegistry{}, err
		}
	}

	return registry, nil
}

func (s server) ensureProjectStorage(project visualProject) error {
	ctx := s.projectContext(project)
	if err := os.MkdirAll(ctx.SnapshotDir, 0o755); err != nil {
		return err
	}
	if err := os.MkdirAll(ctx.ResultsDir, 0o755); err != nil {
		return err
	}

	if project.ID == defaultProjectID {
		return s.migrateLegacyDefaultProject(project)
	}

	if !fileExists(ctx.VisualPagesPath) {
		return writeJSONFile(ctx.VisualPagesPath, visualPagesManifest{
			Version:     1,
			TargetURL:   project.TargetURL,
			GeneratedAt: time.Now().UTC().Format(time.RFC3339Nano),
			Pages:       []visualPage{},
		})
	}

	return nil
}

func (s server) migrateLegacyDefaultProject(project visualProject) error {
	ctx := s.projectContext(project)
	if !fileExists(ctx.VisualPagesPath) {
		legacyManifest, err := s.readLegacyVisualPagesManifest()
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		if err := writeJSONFile(ctx.VisualPagesPath, rewriteVisualPagesManifest(project, legacyManifest)); err != nil {
			return err
		}
	}

	legacySnapshotDir := filepath.Join(s.rootDir, "tests", "visual-test-sample.spec.ts-snapshots")
	if entries, err := os.ReadDir(legacySnapshotDir); err == nil {
		for _, entry := range entries {
			if entry.IsDir() {
				continue
			}
			sourcePath := filepath.Join(legacySnapshotDir, entry.Name())
			destinationPath := filepath.Join(ctx.SnapshotDir, entry.Name())
			if !fileExists(destinationPath) {
				if err := copyFile(sourcePath, destinationPath); err != nil {
					return err
				}
			}
		}
	}

	legacyResultsDir := filepath.Join(s.rootDir, "public", "visual-results")
	if !fileExists(filepath.Join(ctx.ResultsDir, "history.json")) && fileExists(legacyResultsDir) {
		if err := s.copyLegacyResults(legacyResultsDir, ctx.ResultsDir, project.ID); err != nil {
			return err
		}
	}

	return nil
}

func (s server) readLegacyVisualPagesManifest() (visualPagesManifest, error) {
	manifest, err := readJSON[visualPagesManifest](filepath.Join(s.rootDir, "tests", "visual-pages.json"))
	if err != nil {
		return visualPagesManifest{
			Version:     1,
			TargetURL:   defaultTargetURL,
			GeneratedAt: time.Now().UTC().Format(time.RFC3339Nano),
			Pages:       []visualPage{},
		}, err
	}
	return manifest, nil
}

func rewriteVisualPagesManifest(project visualProject, manifest visualPagesManifest) visualPagesManifest {
	if manifest.Version == 0 {
		manifest.Version = 1
	}
	if manifest.TargetURL == "" {
		manifest.TargetURL = project.TargetURL
	}
	if manifest.GeneratedAt == "" {
		manifest.GeneratedAt = time.Now().UTC().Format(time.RFC3339Nano)
	}

	for index := range manifest.Pages {
		page := &manifest.Pages[index]
		if page.BaselineFileName == "" {
			page.BaselineFileName = makeBaselineFileName(page.ID)
		}
		page.BaselineImageURL = projectBaselineImageURL(project.ID, page.BaselineFileName)
		page.SnapshotPath = projectSnapshotPath(project.ID, page.BaselineFileName)
	}

	return manifest
}

func (s server) copyLegacyResults(sourceDir string, destinationDir string, projectID string) error {
	entries, err := os.ReadDir(sourceDir)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(destinationDir, 0o755); err != nil {
		return err
	}

	for _, entry := range entries {
		if entry.Name() == projectID {
			continue
		}

		sourcePath := filepath.Join(sourceDir, entry.Name())
		destinationPath := filepath.Join(destinationDir, entry.Name())
		if entry.IsDir() {
			if err := s.copyTreeRewriteJSON(sourcePath, destinationPath, projectID); err != nil {
				return err
			}
			continue
		}
		if strings.HasSuffix(entry.Name(), ".json") {
			if err := rewriteProjectJSONFile(sourcePath, destinationPath, projectID); err != nil {
				return err
			}
			continue
		}
		if err := copyFile(sourcePath, destinationPath); err != nil {
			return err
		}
	}

	return nil
}

func (s server) copyTreeRewriteJSON(sourceDir string, destinationDir string, projectID string) error {
	entries, err := os.ReadDir(sourceDir)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(destinationDir, 0o755); err != nil {
		return err
	}

	for _, entry := range entries {
		sourcePath := filepath.Join(sourceDir, entry.Name())
		destinationPath := filepath.Join(destinationDir, entry.Name())
		if entry.IsDir() {
			if err := s.copyTreeRewriteJSON(sourcePath, destinationPath, projectID); err != nil {
				return err
			}
			continue
		}
		if strings.HasSuffix(entry.Name(), ".json") {
			if err := rewriteProjectJSONFile(sourcePath, destinationPath, projectID); err != nil {
				return err
			}
			continue
		}
		if err := copyFile(sourcePath, destinationPath); err != nil {
			return err
		}
	}

	return nil
}

func rewriteProjectJSONFile(sourcePath string, destinationPath string, projectID string) error {
	value, err := readJSON[any](sourcePath)
	if err != nil {
		return err
	}
	return writeJSONFile(destinationPath, rewriteProjectReferences(value, projectID))
}

func rewriteProjectReferences(value any, projectID string) any {
	switch typed := value.(type) {
	case map[string]any:
		for key, item := range typed {
			typed[key] = rewriteProjectReferences(item, projectID)
		}
		return typed
	case []any:
		for index, item := range typed {
			typed[index] = rewriteProjectReferences(item, projectID)
		}
		return typed
	case string:
		return rewriteProjectString(typed, projectID)
	default:
		return value
	}
}

func rewriteProjectString(value string, projectID string) string {
	value = strings.ReplaceAll(value, "/assets/baselines/visual-test-sample/", "/assets/baselines/"+projectID+"/")
	value = strings.ReplaceAll(value, "tests/visual-test-sample.spec.ts-snapshots/", filepath.ToSlash(projectSnapshotDir(projectID))+"/")

	visualResultsPrefix := "/visual-results/"
	if strings.HasPrefix(value, visualResultsPrefix) && !strings.HasPrefix(value, visualResultsPrefix+projectID+"/") {
		value = visualResultsPrefix + projectID + "/" + strings.TrimPrefix(value, visualResultsPrefix)
	}

	publicResultsPrefix := "public/visual-results/"
	if strings.HasPrefix(value, publicResultsPrefix) && !strings.HasPrefix(value, publicResultsPrefix+projectID+"/") {
		value = publicResultsPrefix + projectID + "/" + strings.TrimPrefix(value, publicResultsPrefix)
	}

	return value
}

func (s server) projectContext(project visualProject) projectContext {
	projectDir := filepath.Join(s.rootDir, "tests", "visual-projects", project.ID)
	return projectContext{
		Project:         project,
		VisualPagesPath: filepath.Join(projectDir, "visual-pages.json"),
		SnapshotDir:     filepath.Join(projectDir, "snapshots"),
		ResultsDir:      filepath.Join(s.rootDir, "public", "visual-results", project.ID),
	}
}

func (s server) projectRegistryPath() string {
	return filepath.Join(s.rootDir, "tests", "visual-projects.json")
}

func (s server) projectSnapshotDir(projectID string) string {
	return filepath.Join(s.rootDir, projectSnapshotDir(projectID))
}

func projectSnapshotDir(projectID string) string {
	return filepath.Join("tests", "visual-projects", projectID, "snapshots")
}

func projectSnapshotPath(projectID string, fileName string) string {
	return filepath.ToSlash(filepath.Join(projectSnapshotDir(projectID), fileName))
}

func projectBaselineImageURL(projectID string, fileName string) string {
	return "/assets/baselines/" + projectID + "/" + fileName
}

func projectRevisionManifestURL(projectID string, revisionID string) string {
	return "/visual-results/" + projectID + "/revisions/" + revisionID + "/manifest.json"
}

func validProjectID(projectID string) bool {
	return projectID != "" && !strings.Contains(projectID, "/") && !strings.Contains(projectID, "\\") && !strings.Contains(projectID, "..")
}

func slugProjectID(value string) string {
	var builder strings.Builder
	previousHyphen := false

	for _, character := range strings.ToLower(value) {
		if unicode.IsLetter(character) || unicode.IsDigit(character) {
			builder.WriteRune(character)
			previousHyphen = false
			continue
		}
		if !previousHyphen {
			builder.WriteByte('-')
			previousHyphen = true
		}
	}

	slug := strings.Trim(builder.String(), "-")
	if slug == "" {
		return "visual-project"
	}
	return slug
}

func uniqueProjectID(baseID string, projects []visualProject) string {
	usedIDs := make(map[string]bool, len(projects))
	for _, project := range projects {
		usedIDs[project.ID] = true
	}
	if !usedIDs[baseID] {
		return baseID
	}
	for index := 2; ; index++ {
		candidate := fmt.Sprintf("%s-%d", baseID, index)
		if !usedIDs[candidate] {
			return candidate
		}
	}
}

func fileExists(filePath string) bool {
	_, err := os.Stat(filePath)
	return err == nil
}

func (s server) addVisualSection(w http.ResponseWriter, r *http.Request, project projectContext) (sectionResponse, error) {
	name, pageURL, imageBytes, err := readSectionUpload(w, r)
	if err != nil {
		return sectionResponse{}, err
	}

	pagesManifest, err := s.readVisualPagesManifest(project)
	if err != nil {
		return sectionResponse{}, fmt.Errorf("Could not read visual sections.")
	}

	resolvedURL, pagePath, err := resolveSectionURL(pageURL, pagesManifest.TargetURL)
	if err != nil {
		return sectionResponse{}, err
	}

	sectionID := uniqueSectionID(slugFromText(name), pagesManifest.Pages)
	baselineFileName := makeBaselineFileName(sectionID)
	section := visualPage{
		ID:               sectionID,
		Name:             name,
		Path:             pagePath,
		URL:              resolvedURL,
		SnapshotName:     sectionID + ".png",
		BaselineFileName: baselineFileName,
		BaselineImageURL: projectBaselineImageURL(project.Project.ID, baselineFileName),
		SnapshotPath:     projectSnapshotPath(project.Project.ID, baselineFileName),
		ManualBaseline:   true,
	}

	destinationPath := filepath.Join(project.SnapshotDir, baselineFileName)
	if err := writeFileAtomic(destinationPath, imageBytes); err != nil {
		return sectionResponse{}, fmt.Errorf("Could not save the uploaded baseline image.")
	}

	now := time.Now().UTC().Format(time.RFC3339Nano)
	pagesManifest.GeneratedAt = now
	pagesManifest.Pages = append(pagesManifest.Pages, section)
	if pagesManifest.Version == 0 {
		pagesManifest.Version = 1
	}
	if pagesManifest.TargetURL == "" {
		pagesManifest.TargetURL = project.Project.TargetURL
	}

	if err := s.writeVisualPagesManifest(project, pagesManifest); err != nil {
		return sectionResponse{}, fmt.Errorf("Could not register the uploaded visual section.")
	}

	manifest := s.visualPagesToManifest(project, pagesManifest)
	return sectionResponse{
		Message:  "Section added. Run a visual scan to compare it against the uploaded baseline.",
		Section:  visualPageToItem(project.Project, section, pagesManifest.GeneratedAt),
		Manifest: manifest,
	}, nil
}

func (s server) updateVisualSectionDetails(w http.ResponseWriter, r *http.Request, project projectContext, sectionID string) (sectionResponse, error) {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	defer r.Body.Close()

	var request struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		return sectionResponse{}, fmt.Errorf("Section details must be valid JSON.")
	}

	name := strings.TrimSpace(request.Name)
	if name == "" {
		return sectionResponse{}, fmt.Errorf("Section name is required.")
	}

	pagesManifest, err := s.readVisualPagesManifest(project)
	if err != nil {
		return sectionResponse{}, fmt.Errorf("Could not read visual sections.")
	}

	sectionIndex := -1
	for index, section := range pagesManifest.Pages {
		if section.ID == sectionID {
			sectionIndex = index
			break
		}
	}

	if sectionIndex == -1 {
		return sectionResponse{}, fmt.Errorf("The selected section could not be found.")
	}

	section := pagesManifest.Pages[sectionIndex]
	section.Name = name
	pagesManifest.GeneratedAt = time.Now().UTC().Format(time.RFC3339Nano)
	pagesManifest.Pages[sectionIndex] = section

	if err := s.writeVisualPagesManifest(project, pagesManifest); err != nil {
		return sectionResponse{}, fmt.Errorf("Could not update the selected section.")
	}

	manifest := s.visualPagesToManifest(project, pagesManifest)
	return sectionResponse{
		Message:  "Section renamed.",
		Section:  visualPageToItem(project.Project, section, pagesManifest.GeneratedAt),
		Manifest: manifest,
	}, nil
}

func (s server) updateVisualSectionBaseline(w http.ResponseWriter, r *http.Request, project projectContext, sectionID string) (sectionResponse, error) {
	imageBytes, err := readBaselineImageUpload(w, r)
	if err != nil {
		return sectionResponse{}, err
	}

	pagesManifest, err := s.readVisualPagesManifest(project)
	if err != nil {
		return sectionResponse{}, fmt.Errorf("Could not read visual sections.")
	}

	sectionIndex := -1
	for index, section := range pagesManifest.Pages {
		if section.ID == sectionID {
			sectionIndex = index
			break
		}
	}

	if sectionIndex == -1 {
		return sectionResponse{}, fmt.Errorf("The selected section could not be found.")
	}

	section := pagesManifest.Pages[sectionIndex]
	if section.BaselineFileName == "" {
		section.BaselineFileName = makeBaselineFileName(section.ID)
	}
	if section.SnapshotPath == "" {
		section.SnapshotPath = projectSnapshotPath(project.Project.ID, section.BaselineFileName)
	}
	if section.BaselineImageURL == "" {
		section.BaselineImageURL = projectBaselineImageURL(project.Project.ID, section.BaselineFileName)
	}

	destinationPath := filepath.Join(project.SnapshotDir, section.BaselineFileName)
	if err := writeFileAtomic(destinationPath, imageBytes); err != nil {
		return sectionResponse{}, fmt.Errorf("Could not replace the baseline image.")
	}

	now := time.Now().UTC().Format(time.RFC3339Nano)
	section.ManualBaseline = true
	pagesManifest.GeneratedAt = now
	pagesManifest.Pages[sectionIndex] = section

	if err := s.writeVisualPagesManifest(project, pagesManifest); err != nil {
		return sectionResponse{}, fmt.Errorf("Could not update the selected section.")
	}

	manifest := s.visualPagesToManifest(project, pagesManifest)
	return sectionResponse{
		Message:  "Baseline image updated. Future visual scans will compare against this uploaded image.",
		Section:  visualPageToItem(project.Project, section, pagesManifest.GeneratedAt),
		Manifest: manifest,
	}, nil
}

func (s server) deleteVisualSection(project projectContext, sectionID string) (sectionDeleteResponse, error) {
	pagesManifest, err := s.readVisualPagesManifest(project)
	if err != nil {
		return sectionDeleteResponse{}, fmt.Errorf("Could not read visual sections.")
	}

	if len(pagesManifest.Pages) <= 1 {
		return sectionDeleteResponse{}, fmt.Errorf("At least one visual section is required.")
	}

	sectionIndex := -1
	for index, section := range pagesManifest.Pages {
		if section.ID == sectionID {
			sectionIndex = index
			break
		}
	}

	if sectionIndex == -1 {
		return sectionDeleteResponse{}, fmt.Errorf("The selected section could not be found.")
	}

	removedSection := pagesManifest.Pages[sectionIndex]
	pagesManifest.Pages = append(pagesManifest.Pages[:sectionIndex], pagesManifest.Pages[sectionIndex+1:]...)
	pagesManifest.GeneratedAt = time.Now().UTC().Format(time.RFC3339Nano)

	if err := s.writeVisualPagesManifest(project, pagesManifest); err != nil {
		return sectionDeleteResponse{}, fmt.Errorf("Could not remove the selected section.")
	}

	if removedSection.ManualBaseline && removedSection.BaselineFileName != "" {
		_ = os.Remove(filepath.Join(project.SnapshotDir, removedSection.BaselineFileName))
	}

	return sectionDeleteResponse{
		Message:  "Section removed.",
		Manifest: s.visualPagesToManifest(project, pagesManifest),
	}, nil
}

func readSectionRefreshRequest(w http.ResponseWriter, r *http.Request) (bool, error) {
	update := r.URL.Query().Get("update") == "true" || r.URL.Query().Get("update") == "1"

	if r.Body == nil || r.ContentLength == 0 {
		return update, nil
	}
	defer r.Body.Close()

	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)

	var request struct {
		Update *bool `json:"update"`
	}
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil && !errors.Is(err, io.EOF) {
		return false, fmt.Errorf("Refresh options must be valid JSON.")
	}
	if request.Update != nil {
		update = *request.Update
	}

	return update, nil
}

func readSectionUpload(w http.ResponseWriter, r *http.Request) (string, string, []byte, error) {
	formValues, imageBytes, err := readUploadForm(w, r)
	if err != nil {
		return "", "", nil, err
	}

	name := strings.TrimSpace(formValues.Get("name"))
	pageURL := strings.TrimSpace(formValues.Get("url"))

	if name == "" {
		return "", "", nil, fmt.Errorf("Section name is required.")
	}
	if pageURL == "" {
		return "", "", nil, fmt.Errorf("Page URL is required.")
	}

	return name, pageURL, imageBytes, nil
}

func readBaselineImageUpload(w http.ResponseWriter, r *http.Request) ([]byte, error) {
	_, imageBytes, err := readUploadForm(w, r)
	return imageBytes, err
}

func readUploadForm(w http.ResponseWriter, r *http.Request) (url.Values, []byte, error) {
	r.Body = http.MaxBytesReader(w, r.Body, maxBaselineUploadSize+1)
	if err := r.ParseMultipartForm(maxBaselineUploadSize); err != nil {
		return nil, nil, fmt.Errorf("Upload a PNG baseline image smaller than 20 MB.")
	}

	file, _, err := r.FormFile("baselineImage")
	if err != nil {
		return nil, nil, fmt.Errorf("Baseline image upload is required.")
	}
	defer file.Close()

	imageBytes, err := io.ReadAll(io.LimitReader(file, maxBaselineUploadSize+1))
	if err != nil {
		return nil, nil, fmt.Errorf("Could not read the uploaded baseline image.")
	}
	if int64(len(imageBytes)) > maxBaselineUploadSize {
		return nil, nil, fmt.Errorf("Upload a PNG baseline image smaller than 20 MB.")
	}
	if !isPNG(imageBytes) {
		return nil, nil, fmt.Errorf("Only PNG baseline images are supported.")
	}

	formValues := url.Values{}
	if r.MultipartForm != nil {
		for key, values := range r.MultipartForm.Value {
			formValues[key] = values
		}
	}

	return formValues, imageBytes, nil
}

func isPNG(imageBytes []byte) bool {
	return bytes.HasPrefix(imageBytes, []byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'})
}

func resolveSectionURL(rawURL string, baseURL string) (string, string, error) {
	base := defaultTargetURL
	if strings.TrimSpace(baseURL) != "" {
		base = strings.TrimSpace(baseURL)
	}

	parsedBase, err := url.Parse(base)
	if err != nil {
		return "", "", fmt.Errorf("The configured target URL is invalid.")
	}

	parsedURL, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil {
		return "", "", fmt.Errorf("Page URL is invalid.")
	}
	if !parsedURL.IsAbs() {
		parsedURL = parsedBase.ResolveReference(parsedURL)
	}
	if parsedURL.Scheme != "http" && parsedURL.Scheme != "https" {
		return "", "", fmt.Errorf("Page URL must be an HTTP or HTTPS URL.")
	}

	parsedURL.Fragment = ""
	pagePath := parsedURL.EscapedPath()
	if pagePath == "" {
		pagePath = "/"
	}
	if parsedURL.RawQuery != "" {
		pagePath += "?" + parsedURL.RawQuery
	}

	return parsedURL.String(), pagePath, nil
}

func slugFromText(value string) string {
	var builder strings.Builder
	previousHyphen := false

	for _, character := range strings.ToLower(value) {
		if unicode.IsLetter(character) || unicode.IsDigit(character) {
			builder.WriteRune(character)
			previousHyphen = false
			continue
		}

		if !previousHyphen {
			builder.WriteByte('-')
			previousHyphen = true
		}
	}

	slug := strings.Trim(builder.String(), "-")
	if slug == "" {
		slug = "manual-section"
	}
	if !strings.HasSuffix(slug, "-page") {
		slug += "-page"
	}

	return slug
}

func uniqueSectionID(baseID string, pages []visualPage) string {
	usedIDs := make(map[string]bool, len(pages))
	for _, page := range pages {
		usedIDs[page.ID] = true
	}

	if !usedIDs[baseID] {
		return baseID
	}

	for index := 2; ; index++ {
		candidate := fmt.Sprintf("%s-%d", baseID, index)
		if !usedIDs[candidate] {
			return candidate
		}
	}
}

func makeBaselineFileName(sectionID string) string {
	return fmt.Sprintf("%s-chromium-%s.png", sectionID, runtime.GOOS)
}

func (s server) acceptOneRevisionItem(project projectContext, revisionID string, itemID string) (acceptResponse, error) {
	return s.acceptRevisionItems(project, revisionID, map[string]bool{itemID: true}, false)
}

func (s server) acceptAllRevisionItems(project projectContext, revisionID string) (acceptResponse, error) {
	return s.acceptRevisionItems(project, revisionID, nil, true)
}

func (s server) acceptRevisionItems(project projectContext, revisionID string, acceptedItemIDs map[string]bool, acceptAll bool) (acceptResponse, error) {
	manifestPath := filepath.Join(project.ResultsDir, "revisions", revisionID, "manifest.json")
	manifest, err := readJSON[revisionManifest](manifestPath)
	if err != nil {
		return acceptResponse{}, fmt.Errorf("Could not read the selected visual revision.")
	}

	if manifest.RevisionID != revisionID {
		return acceptResponse{}, fmt.Errorf("The selected visual revision does not match its manifest.")
	}

	if len(manifest.Items) == 0 {
		return acceptResponse{}, fmt.Errorf("The selected visual revision has no screenshots to accept.")
	}

	acceptedCount := 0
	for index := range manifest.Items {
		item := &manifest.Items[index]
		if !acceptAll && !acceptedItemIDs[item.ID] {
			continue
		}

		if item.ActualPath == nil || *item.ActualPath == "" {
			return acceptResponse{}, fmt.Errorf("%s does not have a current screenshot to accept.", item.Name)
		}

		sourcePath, err := s.safeRepoPath(*item.ActualPath)
		if err != nil {
			return acceptResponse{}, fmt.Errorf("%s has an invalid current screenshot path.", item.Name)
		}

		destinationPath, err := s.safeRepoPath(item.SnapshotPath)
		if err != nil || !isInside(project.SnapshotDir, destinationPath) {
			return acceptResponse{}, fmt.Errorf("%s has an invalid baseline screenshot path.", item.Name)
		}

		if err := copyFile(sourcePath, destinationPath); err != nil {
			return acceptResponse{}, fmt.Errorf("Could not accept %s as the new baseline.", item.Name)
		}

		item.Status = statusAccepted
		item.DiffImageURL = nil
		item.DiffPath = nil
		item.ErrorContextPath = nil
		item.Summary = fmt.Sprintf("%s was accepted as the approved baseline.", item.Name)
		item.Description = "The current screenshot has replaced the previous original baseline for future comparisons."
		acceptedCount++
	}

	if acceptedCount == 0 {
		return acceptResponse{}, fmt.Errorf("No matching page was found to accept.")
	}

	now := time.Now().UTC().Format(time.RFC3339Nano)
	manifest.AcceptedAt = &now
	refreshManifestCounts(&manifest)

	if err := writeJSONFile(manifestPath, manifest); err != nil {
		return acceptResponse{}, fmt.Errorf("Could not update the accepted visual revision.")
	}

	history, err := s.updateHistoryForRevision(project, manifest)
	if err != nil {
		return acceptResponse{}, err
	}

	latestManifestPath := filepath.Join(project.ResultsDir, "manifest.json")
	latestManifest, err := readJSON[revisionManifest](latestManifestPath)
	if err == nil && latestManifest.RevisionID == revisionID {
		manifest.LatestRevisionID = revisionID
		manifest.LatestManifestURL = projectRevisionManifestURL(project.Project.ID, revisionID)
		if err := writeJSONFile(latestManifestPath, manifest); err != nil {
			return acceptResponse{}, fmt.Errorf("Could not update the latest visual revision.")
		}
	}

	message := "The selected page is now the approved baseline."
	if acceptAll {
		message = "All current screenshots in this run are now the approved baselines."
	}

	return acceptResponse{
		Message:  message,
		History:  history,
		Manifest: manifest,
	}, nil
}

func refreshManifestCounts(manifest *revisionManifest) {
	changedPages := 0
	acceptedPages := 0
	for _, item := range manifest.Items {
		if item.Status == statusChanged {
			changedPages++
		}
		if item.Status == statusAccepted {
			acceptedPages++
		}
	}

	manifest.ChangedPages = changedPages
	manifest.CleanPages = manifest.TotalPages - changedPages
	if changedPages > 0 {
		manifest.Status = statusChanged
	} else if acceptedPages > 0 {
		manifest.Status = statusAccepted
	} else {
		manifest.Status = statusClean
	}
	manifest.Label = labelWithStatus(manifest.CreatedAt, manifest.Status)
}

func (s server) updateHistoryForRevision(project projectContext, manifest revisionManifest) (visualHistory, error) {
	historyPath := filepath.Join(project.ResultsDir, "history.json")
	history, err := readJSON[visualHistory](historyPath)
	if err != nil {
		return visualHistory{}, fmt.Errorf("Could not read visual revision history.")
	}

	for index := range history.Revisions {
		if history.Revisions[index].ID == manifest.RevisionID {
			history.Revisions[index].Status = manifest.Status
			history.Revisions[index].AcceptedAt = manifest.AcceptedAt
			history.Revisions[index].Label = manifest.Label
			history.Revisions[index].ChangedPages = manifest.ChangedPages
			history.Revisions[index].CleanPages = manifest.CleanPages
			break
		}
	}

	history.GeneratedAt = time.Now().UTC().Format(time.RFC3339Nano)
	if err := writeJSONFile(historyPath, history); err != nil {
		return visualHistory{}, fmt.Errorf("Could not update visual revision history.")
	}

	return history, nil
}

func (s server) readVisualPagesManifest(project projectContext) (visualPagesManifest, error) {
	manifest, err := readJSON[visualPagesManifest](project.VisualPagesPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return visualPagesManifest{
				Version:     1,
				TargetURL:   project.Project.TargetURL,
				GeneratedAt: time.Now().UTC().Format(time.RFC3339Nano),
				Pages:       []visualPage{},
			}, nil
		}

		return visualPagesManifest{}, err
	}

	if manifest.Version == 0 {
		manifest.Version = 1
	}
	if manifest.TargetURL == "" {
		manifest.TargetURL = project.Project.TargetURL
	}

	return manifest, nil
}

func (s server) writeVisualPagesManifest(project projectContext, manifest visualPagesManifest) error {
	return writeJSONFile(project.VisualPagesPath, manifest)
}

func (s server) visualPagesToManifest(project projectContext, pagesManifest visualPagesManifest) revisionManifest {
	items := make([]visualItem, 0, len(pagesManifest.Pages))
	for _, page := range pagesManifest.Pages {
		items = append(items, visualPageToItem(project.Project, page, pagesManifest.GeneratedAt))
	}

	generatedAt := pagesManifest.GeneratedAt
	if generatedAt == "" {
		generatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	}

	return revisionManifest{
		Version:     1,
		Status:      statusBaseline,
		CreatedAt:   generatedAt,
		GeneratedAt: generatedAt,
		Label:       "Registered sections",
		TargetURL:   pagesManifest.TargetURL,
		TotalPages:  len(items),
		Items:       items,
	}
}

func visualPageToItem(project visualProject, page visualPage, generatedAt string) visualItem {
	if generatedAt == "" {
		generatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	}

	baselineFileName := page.BaselineFileName
	if baselineFileName == "" {
		baselineFileName = makeBaselineFileName(page.ID)
	}

	snapshotPath := page.SnapshotPath
	if snapshotPath == "" {
		snapshotPath = projectSnapshotPath(project.ID, baselineFileName)
	}

	baselineImageURL := page.BaselineImageURL
	if baselineImageURL == "" {
		baselineImageURL = projectBaselineImageURL(project.ID, baselineFileName)
	}

	return visualItem{
		ID:               page.ID,
		Name:             page.Name,
		Source:           project.Name,
		TargetURL:        page.URL,
		Browser:          "Chromium",
		Viewport:         "1440 x 900",
		SnapshotName:     page.SnapshotName,
		BaselineFileName: baselineFileName,
		BaselineImageURL: baselineImageURL,
		SnapshotPath:     snapshotPath,
		Path:             page.Path,
		URL:              page.URL,
		Status:           statusBaseline,
		GeneratedAt:      generatedAt,
		Summary:          page.Name + " baseline is ready.",
		Description:      "This screenshot is the original approved image used for future comparisons.",
		Actions:          page.Actions,
	}
}

func (s server) safeRepoPath(relativePath string) (string, error) {
	if relativePath == "" || filepath.IsAbs(relativePath) {
		return "", errors.New("path must be relative")
	}

	cleanPath := filepath.Clean(relativePath)
	fullPath := filepath.Join(s.rootDir, cleanPath)
	if !isInside(s.rootDir, fullPath) {
		return "", errors.New("path escapes repository")
	}

	return fullPath, nil
}

func isInside(parentPath string, childPath string) bool {
	parent, err := filepath.Abs(parentPath)
	if err != nil {
		return false
	}

	child, err := filepath.Abs(childPath)
	if err != nil {
		return false
	}

	relative, err := filepath.Rel(parent, child)
	if err != nil {
		return false
	}

	return relative == "." || (!strings.HasPrefix(relative, "..") && !filepath.IsAbs(relative))
}

func copyFile(sourcePath string, destinationPath string) error {
	source, err := os.Open(sourcePath)
	if err != nil {
		return err
	}
	defer source.Close()

	if err := os.MkdirAll(filepath.Dir(destinationPath), 0o755); err != nil {
		return err
	}

	tempPath := destinationPath + ".tmp"
	destination, err := os.Create(tempPath)
	if err != nil {
		return err
	}

	if _, err := io.Copy(destination, source); err != nil {
		destination.Close()
		return err
	}

	if err := destination.Close(); err != nil {
		return err
	}

	return os.Rename(tempPath, destinationPath)
}

func writeFileAtomic(destinationPath string, content []byte) error {
	if err := os.MkdirAll(filepath.Dir(destinationPath), 0o755); err != nil {
		return err
	}

	tempPath := destinationPath + ".tmp"
	if err := os.WriteFile(tempPath, content, 0o644); err != nil {
		return err
	}

	return os.Rename(tempPath, destinationPath)
}

func labelWithStatus(createdAt string, status visualStatus) string {
	timestamp := createdAt
	if parsed, err := time.Parse(time.RFC3339Nano, createdAt); err == nil {
		timestamp = parsed.Local().Format("Jan 2, 2006, 3:04 PM")
	}

	switch status {
	case statusAccepted:
		return timestamp + " - Accepted as baseline"
	case statusChanged:
		return timestamp + " - Difference detected"
	case statusClean:
		return timestamp + " - Matches baseline"
	default:
		return timestamp + " - Baseline"
	}
}

func readJSON[T any](filePath string) (T, error) {
	var value T
	file, err := os.Open(filePath)
	if err != nil {
		return value, err
	}
	defer file.Close()

	if err := json.NewDecoder(file).Decode(&value); err != nil {
		return value, err
	}

	return value, nil
}

func writeJSONFile(filePath string, value any) error {
	if err := os.MkdirAll(filepath.Dir(filePath), 0o755); err != nil {
		return err
	}

	tempPath := filePath + ".tmp"
	file, err := os.Create(tempPath)
	if err != nil {
		return err
	}

	encoder := json.NewEncoder(file)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(value); err != nil {
		file.Close()
		return err
	}

	if err := file.Close(); err != nil {
		return err
	}

	return os.Rename(tempPath, filePath)
}

func writeJSON(w http.ResponseWriter, statusCode int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(statusCode)
	if err := json.NewEncoder(w).Encode(value); err != nil {
		log.Printf("write response failed: %v", err)
	}
}

func writeError(w http.ResponseWriter, statusCode int, message string) {
	writeJSON(w, statusCode, map[string]string{"error": message})
}

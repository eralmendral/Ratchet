package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type visualStatus string

const (
	statusBaseline visualStatus = "baseline"
	statusClean    visualStatus = "clean"
	statusChanged  visualStatus = "changed"
	statusAccepted visualStatus = "accepted"
)

type visualItem struct {
	ID               string       `json:"id"`
	Name             string       `json:"name"`
	Source           string       `json:"source"`
	TargetURL        string       `json:"targetUrl"`
	Browser          string       `json:"browser"`
	Viewport         string       `json:"viewport"`
	SnapshotName     string       `json:"snapshotName"`
	BaselineFileName string       `json:"baselineFileName"`
	BaselineImageURL string       `json:"baselineImageUrl"`
	SnapshotPath     string       `json:"snapshotPath"`
	Path             string       `json:"path"`
	URL              string       `json:"url"`
	Status           visualStatus `json:"status"`
	GeneratedAt      string       `json:"generatedAt"`
	RevisionID       string       `json:"revisionId"`
	ActualImageURL   *string      `json:"actualImageUrl"`
	DiffImageURL     *string      `json:"diffImageUrl"`
	ActualPath       *string      `json:"actualPath"`
	DiffPath         *string      `json:"diffPath"`
	ErrorContextPath *string      `json:"errorContextPath"`
	Summary          string       `json:"summary"`
	Description      string       `json:"description"`
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

type server struct {
	rootDir          string
	staticDir        string
	visualResultsDir string
	snapshotDir      string
	scanMu           sync.Mutex
	scanning         bool
}

func main() {
	rootDir, err := os.Getwd()
	if err != nil {
		log.Fatal(err)
	}

	s := server{
		rootDir:          rootDir,
		staticDir:        filepath.Join(rootDir, "dist", "ratchet", "browser"),
		visualResultsDir: filepath.Join(rootDir, "public", "visual-results"),
		snapshotDir:      filepath.Join(rootDir, "tests", "visual-test-sample.spec.ts-snapshots"),
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/api/health", s.handleHealth)
	mux.HandleFunc("/api/visual-scan", s.handleVisualScan)
	mux.HandleFunc("/api/visual-revisions/", s.handleVisualRevision)
	mux.Handle("/visual-results/", http.StripPrefix("/visual-results/", http.FileServer(http.Dir(s.visualResultsDir))))
	mux.Handle("/assets/baselines/visual-test-sample/", http.StripPrefix("/assets/baselines/visual-test-sample/", http.FileServer(http.Dir(s.snapshotDir))))
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
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
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

func (s *server) handleVisualScan(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "Only POST is supported.")
		return
	}

	response, err := s.runVisualScan()
	if err != nil {
		log.Printf("visual scan failed: %v", err)
		if errors.Is(err, errScanAlreadyRunning) {
			writeError(w, http.StatusConflict, err.Error())
			return
		}
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	writeJSON(w, http.StatusOK, response)
}

func (s server) handleVisualRevision(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "Only POST is supported.")
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
	var err error

	switch {
	case len(parts) == 2 && parts[1] == "accept-all":
		response, err = s.acceptAllRevisionItems(revisionID)
	case len(parts) == 4 && parts[1] == "items" && parts[3] == "accept" && parts[2] != "":
		response, err = s.acceptOneRevisionItem(revisionID, parts[2])
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

func (s *server) runVisualScan() (scanResponse, error) {
	s.scanMu.Lock()
	if s.scanning {
		s.scanMu.Unlock()
		return scanResponse{}, errScanAlreadyRunning
	}
	s.scanning = true
	s.scanMu.Unlock()

	defer func() {
		s.scanMu.Lock()
		s.scanning = false
		s.scanMu.Unlock()
	}()

	command := exec.Command("npm", "run", "test:visual")
	command.Dir = s.rootDir
	outputBytes, err := command.CombinedOutput()
	output := string(outputBytes)
	exitCode := 0

	if err != nil {
		var exitError *exec.ExitError
		if errors.As(err, &exitError) {
			exitCode = exitError.ExitCode()
		} else {
			return scanResponse{}, fmt.Errorf("Could not run the visual scan.")
		}
	}

	history, err := readJSON[visualHistory](filepath.Join(s.visualResultsDir, "history.json"))
	if err != nil {
		return scanResponse{}, fmt.Errorf("The visual scan finished, but the revision history could not be read.")
	}

	manifest, err := readJSON[revisionManifest](filepath.Join(s.visualResultsDir, "manifest.json"))
	if err != nil {
		return scanResponse{}, fmt.Errorf("The visual scan finished, but the latest visual revision could not be read.")
	}

	message := "Visual scan completed and matches the approved baseline."
	if exitCode != 0 {
		message = "Visual scan completed and found differences that need review."
	}

	return scanResponse{
		Message:  message,
		ExitCode: exitCode,
		Output:   output,
		History:  history,
		Manifest: manifest,
	}, nil
}

func (s server) acceptOneRevisionItem(revisionID string, itemID string) (acceptResponse, error) {
	return s.acceptRevisionItems(revisionID, map[string]bool{itemID: true}, false)
}

func (s server) acceptAllRevisionItems(revisionID string) (acceptResponse, error) {
	return s.acceptRevisionItems(revisionID, nil, true)
}

func (s server) acceptRevisionItems(revisionID string, acceptedItemIDs map[string]bool, acceptAll bool) (acceptResponse, error) {
	manifestPath := filepath.Join(s.visualResultsDir, "revisions", revisionID, "manifest.json")
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
		if err != nil || !isInside(s.snapshotDir, destinationPath) {
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

	history, err := s.updateHistoryForRevision(manifest)
	if err != nil {
		return acceptResponse{}, err
	}

	latestManifestPath := filepath.Join(s.visualResultsDir, "manifest.json")
	latestManifest, err := readJSON[revisionManifest](latestManifestPath)
	if err == nil && latestManifest.RevisionID == revisionID {
		manifest.LatestRevisionID = revisionID
		manifest.LatestManifestURL = "/visual-results/revisions/" + revisionID + "/manifest.json"
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

func (s server) updateHistoryForRevision(manifest revisionManifest) (visualHistory, error) {
	historyPath := filepath.Join(s.visualResultsDir, "history.json")
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

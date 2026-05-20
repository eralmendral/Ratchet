package main

import (
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
	defaultTargetURL      = "https://visual-test-sample.vercel.app/"
	maxBaselineUploadSize = 20 << 20
)

type visualPagesManifest struct {
	Version     int          `json:"version"`
	TargetURL   string       `json:"targetUrl"`
	GeneratedAt string       `json:"generatedAt"`
	Pages       []visualPage `json:"pages"`
}

type visualPage struct {
	ID               string `json:"id"`
	Name             string `json:"name"`
	Path             string `json:"path"`
	URL              string `json:"url"`
	SnapshotName     string `json:"snapshotName"`
	BaselineFileName string `json:"baselineFileName"`
	BaselineImageURL string `json:"baselineImageUrl"`
	SnapshotPath     string `json:"snapshotPath"`
	ManualBaseline   bool   `json:"manualBaseline,omitempty"`
}

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

type sectionResponse struct {
	Message  string           `json:"message"`
	Section  visualItem       `json:"section"`
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
	mux.HandleFunc("/api/visual-sections", s.handleVisualSections)
	mux.HandleFunc("/api/visual-sections/", s.handleVisualSection)
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

func (s server) handleVisualSections(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		manifest, err := s.readVisualPagesManifest()
		if err != nil {
			writeError(w, http.StatusBadRequest, "Could not read visual sections.")
			return
		}

		writeJSON(w, http.StatusOK, s.visualPagesToManifest(manifest))
	case http.MethodPost:
		response, err := s.addVisualSection(w, r)
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

func (s server) handleVisualSection(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "Only POST is supported.")
		return
	}

	pathSuffix := strings.TrimPrefix(r.URL.Path, "/api/visual-sections/")
	parts := strings.Split(strings.Trim(pathSuffix, "/"), "/")
	if len(parts) != 2 || parts[0] == "" || strings.Contains(parts[0], "..") {
		writeError(w, http.StatusBadRequest, "Use /api/visual-sections/{sectionID}/baseline or /api/visual-sections/{sectionID}/scan.")
		return
	}

	switch parts[1] {
	case "baseline":
		response, err := s.updateVisualSectionBaseline(w, r, parts[0])
		if err != nil {
			log.Printf("update section baseline failed: %v", err)
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}

		writeJSON(w, http.StatusOK, response)
	case "scan":
		response, err := s.runVisualScan(r.Context(), parts[0])
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

	response, err := s.runVisualScan(r.Context(), "")
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

func (s *server) runVisualScan(ctx context.Context, sectionID string) (scanResponse, error) {
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

	commandArgs := []string{"run", "test:visual"}
	if sectionID != "" {
		commandArgs = append(commandArgs, "--", "--section="+sectionID)
	}

	command := exec.CommandContext(ctx, "npm", commandArgs...)
	command.Dir = s.rootDir
	outputBytes, err := command.CombinedOutput()
	output := string(outputBytes)
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

func (s server) addVisualSection(w http.ResponseWriter, r *http.Request) (sectionResponse, error) {
	name, pageURL, imageBytes, err := readSectionUpload(w, r)
	if err != nil {
		return sectionResponse{}, err
	}

	pagesManifest, err := s.readVisualPagesManifest()
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
		BaselineImageURL: "/assets/baselines/visual-test-sample/" + baselineFileName,
		SnapshotPath:     "tests/visual-test-sample.spec.ts-snapshots/" + baselineFileName,
		ManualBaseline:   true,
	}

	destinationPath := filepath.Join(s.snapshotDir, baselineFileName)
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
		pagesManifest.TargetURL = defaultTargetURL
	}

	if err := s.writeVisualPagesManifest(pagesManifest); err != nil {
		return sectionResponse{}, fmt.Errorf("Could not register the uploaded visual section.")
	}

	manifest := s.visualPagesToManifest(pagesManifest)
	return sectionResponse{
		Message:  "Section added. Run a visual scan to compare it against the uploaded baseline.",
		Section:  visualPageToItem(section, pagesManifest.GeneratedAt),
		Manifest: manifest,
	}, nil
}

func (s server) updateVisualSectionBaseline(w http.ResponseWriter, r *http.Request, sectionID string) (sectionResponse, error) {
	imageBytes, err := readBaselineImageUpload(w, r)
	if err != nil {
		return sectionResponse{}, err
	}

	pagesManifest, err := s.readVisualPagesManifest()
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
		section.SnapshotPath = "tests/visual-test-sample.spec.ts-snapshots/" + section.BaselineFileName
	}
	if section.BaselineImageURL == "" {
		section.BaselineImageURL = "/assets/baselines/visual-test-sample/" + section.BaselineFileName
	}

	destinationPath := filepath.Join(s.snapshotDir, section.BaselineFileName)
	if err := writeFileAtomic(destinationPath, imageBytes); err != nil {
		return sectionResponse{}, fmt.Errorf("Could not replace the baseline image.")
	}

	now := time.Now().UTC().Format(time.RFC3339Nano)
	section.ManualBaseline = true
	pagesManifest.GeneratedAt = now
	pagesManifest.Pages[sectionIndex] = section

	if err := s.writeVisualPagesManifest(pagesManifest); err != nil {
		return sectionResponse{}, fmt.Errorf("Could not update the selected section.")
	}

	manifest := s.visualPagesToManifest(pagesManifest)
	return sectionResponse{
		Message:  "Baseline image updated. Future visual scans will compare against this uploaded image.",
		Section:  visualPageToItem(section, pagesManifest.GeneratedAt),
		Manifest: manifest,
	}, nil
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

func (s server) readVisualPagesManifest() (visualPagesManifest, error) {
	manifestPath := filepath.Join(s.rootDir, "tests", "visual-pages.json")
	manifest, err := readJSON[visualPagesManifest](manifestPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return visualPagesManifest{
				Version:     1,
				TargetURL:   defaultTargetURL,
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
		manifest.TargetURL = defaultTargetURL
	}

	return manifest, nil
}

func (s server) writeVisualPagesManifest(manifest visualPagesManifest) error {
	return writeJSONFile(filepath.Join(s.rootDir, "tests", "visual-pages.json"), manifest)
}

func (s server) visualPagesToManifest(pagesManifest visualPagesManifest) revisionManifest {
	items := make([]visualItem, 0, len(pagesManifest.Pages))
	for _, page := range pagesManifest.Pages {
		items = append(items, visualPageToItem(page, pagesManifest.GeneratedAt))
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

func visualPageToItem(page visualPage, generatedAt string) visualItem {
	if generatedAt == "" {
		generatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	}

	baselineFileName := page.BaselineFileName
	if baselineFileName == "" {
		baselineFileName = makeBaselineFileName(page.ID)
	}

	snapshotPath := page.SnapshotPath
	if snapshotPath == "" {
		snapshotPath = "tests/visual-test-sample.spec.ts-snapshots/" + baselineFileName
	}

	baselineImageURL := page.BaselineImageURL
	if baselineImageURL == "" {
		baselineImageURL = "/assets/baselines/visual-test-sample/" + baselineFileName
	}

	return visualItem{
		ID:               page.ID,
		Name:             page.Name,
		Source:           "Visual Test Sample",
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

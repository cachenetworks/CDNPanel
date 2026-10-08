// Package cdnpanel is the official Go SDK for the CDNPanel API.
//
//	c := cdnpanel.New("https://cdn.example.com", os.Getenv("CDN_API_KEY"))
//	res, err := c.ListAndSearchFiles(ctx, url.Values{"q": {"logo"}})
//	var page struct{ Data []map[string]any }
//	err = res.Decode(&page)
//
// Endpoint methods are generated into generated.go from the OpenAPI document.
package cdnpanel

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"strconv"
	"time"
)

// Client calls the CDNPanel REST API with an API key.
type Client struct {
	BaseURL    string
	APIKey     string
	HTTPClient *http.Client
	// Retries for 429 / 5xx on idempotent requests.
	Retries   int
	UserAgent string
}

// New returns a client with sensible defaults.
func New(baseURL, apiKey string) *Client {
	for len(baseURL) > 0 && baseURL[len(baseURL)-1] == '/' {
		baseURL = baseURL[:len(baseURL)-1]
	}
	return &Client{BaseURL: baseURL, APIKey: apiKey, HTTPClient: &http.Client{Timeout: 5 * time.Minute}, Retries: 2, UserAgent: "cdnpanel-go/2.0"}
}

// Response wraps a successful HTTP response.
type Response struct {
	StatusCode int
	Header     http.Header
	Body       []byte
}

// Decode unmarshals the JSON body into v.
func (r *Response) Decode(v any) error { return json.Unmarshal(r.Body, v) }

// APIError is returned for non-2xx responses; Code is the stable error code.
type APIError struct {
	Status    int    `json:"-"`
	Code      string `json:"code"`
	Message   string `json:"message"`
	RequestID string `json:"request_id"`
	Details   any    `json:"details,omitempty"`
}

func (e *APIError) Error() string { return fmt.Sprintf("cdnpanel: %s (%d): %s", e.Code, e.Status, e.Message) }

// Multipart describes a multipart upload: Fields are sent before the file, as the API requires.
type Multipart struct {
	Fields   map[string]string
	FileName string
	File     io.Reader
}

func (c *Client) do(ctx context.Context, method, path string, query url.Values, body any, form *Multipart, raw []byte) (*Response, error) {
	u := c.BaseURL + path
	if len(query) > 0 {
		u += "?" + query.Encode()
	}
	var payload []byte
	contentType := ""
	switch {
	case form != nil:
		var buf bytes.Buffer
		w := multipart.NewWriter(&buf)
		for k, v := range form.Fields {
			_ = w.WriteField(k, v)
		}
		fw, err := w.CreateFormFile("file", form.FileName)
		if err != nil {
			return nil, err
		}
		if _, err := io.Copy(fw, form.File); err != nil {
			return nil, err
		}
		_ = w.Close()
		payload, contentType = buf.Bytes(), w.FormDataContentType()
	case raw != nil:
		payload, contentType = raw, "application/octet-stream"
	case body != nil:
		b, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		payload, contentType = b, "application/json"
	}
	attempts := 1
	if method == http.MethodGet || method == http.MethodHead || method == http.MethodPut || method == http.MethodDelete {
		attempts += c.Retries
	}
	var lastErr error
	for attempt := 1; attempt <= attempts; attempt++ {
		req, err := http.NewRequestWithContext(ctx, method, u, bytes.NewReader(payload))
		if err != nil {
			return nil, err
		}
		req.Header.Set("Authorization", "Bearer "+c.APIKey)
		req.Header.Set("Accept", "application/json")
		req.Header.Set("User-Agent", c.UserAgent)
		if contentType != "" {
			req.Header.Set("Content-Type", contentType)
		}
		res, err := c.HTTPClient.Do(req)
		if err != nil {
			lastErr = err
			if attempt < attempts {
				time.Sleep(time.Duration(250<<attempt) * time.Millisecond)
				continue
			}
			return nil, err
		}
		data, err := io.ReadAll(res.Body)
		res.Body.Close()
		if err != nil {
			return nil, err
		}
		if (res.StatusCode == 429 || res.StatusCode >= 500) && attempt < attempts {
			wait := time.Duration(250<<attempt) * time.Millisecond
			if s, err := strconv.Atoi(res.Header.Get("Retry-After")); err == nil && s > 0 {
				wait = time.Duration(s) * time.Second
			}
			time.Sleep(wait)
			continue
		}
		if res.StatusCode >= 300 {
			var env struct {
				Error APIError `json:"error"`
			}
			_ = json.Unmarshal(data, &env)
			env.Error.Status = res.StatusCode
			if env.Error.Code == "" {
				env.Error.Code = "http_error"
				env.Error.Message = res.Status
			}
			return nil, &env.Error
		}
		return &Response{StatusCode: res.StatusCode, Header: res.Header, Body: data}, nil
	}
	return nil, lastErr
}

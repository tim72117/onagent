package main

import (
	"database/sql"
	"encoding/xml"
	"fmt"
	"regexp"
	"sort"
	"strings"
)

// ---------------------------------------------------------------------------
// 對應 PHP: AnalysisController::getAnalysisQuestions (舊結構分支)
//
//   file_analysis    (tablename, file_id_ques)
//   file_ques_census (file_id = file_analysis.file_id_ques)
//   file_ques_page   (file_id, page, xml, blueprint)
//   analysis_data.INFORMATION_SCHEMA.COLUMNS  → 欄位過濾
//
// 流程:
//   1. 依 file_id 從 file_ques_page 撈各頁 xml，依 page 排序。
//   2. 每頁 xml → 解析 <question> → 攤平成題目清單 (QuestionXML::getSubs)。
//   3. 用資料表欄位過濾掉不存在的題目 name。
//   4. start / amount 分頁。
// ---------------------------------------------------------------------------

// Question 對應前端需要的題目結構 (參考 QuestionXML::toArray / getSubs 攤平後的欄位)。
type Question struct {
	Name    string   `json:"name"`
	Title   string   `json:"title"`
	Choosed bool     `json:"choosed"`
	Answers []Answer `json:"answers,omitempty"`
}

type Answer struct {
	Value string `json:"value"`
	Title string `json:"title"`
}

// getAnalysisQuestions 仿照 PHP 舊結構分支，從資料庫讀題目。
//
// 進入點為 file_analysis.id；對應 PHP $doc->for->analysis：
//
//	file_analysis.id = analysisID
//	  ├─ tablename     → 題目資料表名 (analysis_data.dbo.{tablename})，欄位過濾用
//	  └─ file_id_ques  → file_ques_page.file_id → 各頁 xml (census pages)
//
//	chooseds  → 已勾選的欄位 name (對應 Session 'analysis-columns-choosed')
//	start, amount → 分頁; amount < 0 表示不限 (對應 PHP count($questions) 預設)
func getAnalysisQuestions(db *sql.DB, analysisID int, chooseds []string, start, amount int) ([]Question, error) {
	tablename, fileIDQues, err := fetchAnalysis(db, analysisID)
	if err != nil {
		return nil, fmt.Errorf("讀取 file_analysis 失敗: %w", err)
	}

	columns, err := fetchTableColumns(db, tablename)
	if err != nil {
		return nil, fmt.Errorf("讀取資料表欄位失敗: %w", err)
	}

	pages, err := fetchCensusPages(db, fileIDQues)
	if err != nil {
		return nil, fmt.Errorf("讀取 census pages 失敗: %w", err)
	}

	var questions []Question
	if len(pages) > 0 {
		// 有 census → 解析 XML 取題目 (xmlToArray + getSubs)
		for _, page := range pages {
			parsed, perr := parsePageXML(page.XML)
			if perr != nil {
				return nil, fmt.Errorf("解析第 %d 頁 XML 失敗: %w", page.Page, perr)
			}
			questions = append(questions, parsed...)
		}
	} else {
		// 無 census → 直接用資料表欄位當題目 (PHP else 分支)
		for _, col := range columns {
			if col != "身分識別碼" {
				questions = append(questions, Question{Name: col, Title: col})
			}
		}
	}

	// 標記 choosed + 過濾掉資料表沒有的欄位 (PHP reject)
	colSet := make(map[string]struct{}, len(columns))
	for _, c := range columns {
		colSet[c] = struct{}{}
	}
	chooseSet := make(map[string]struct{}, len(chooseds))
	for _, c := range chooseds {
		chooseSet[c] = struct{}{}
	}

	filtered := questions[:0]
	for _, q := range questions {
		if _, ok := colSet[q.Name]; !ok {
			continue
		}
		if _, ok := chooseSet[q.Name]; ok {
			q.Choosed = true
		}
		filtered = append(filtered, q)
	}

	// start / amount 分頁 (對應 Collection::slice)
	return sliceQuestions(filtered, start, amount), nil
}

func sliceQuestions(qs []Question, start, amount int) []Question {
	if start < 0 {
		start = 0
	}
	if start >= len(qs) {
		return []Question{}
	}
	end := len(qs)
	if amount >= 0 && start+amount < end {
		end = start + amount
	}
	return qs[start:end]
}

// ---------------------------------------------------------------------------
// DB 查詢
// ---------------------------------------------------------------------------

// fetchAnalysis 由 file_analysis.id 取得題目資料表名與 census 的 file_id。
// 對應 PHP $doc->for->analysis 的 tablename 與 file_id_ques。
func fetchAnalysis(db *sql.DB, analysisID int) (tablename string, fileIDQues int, err error) {
	const q = `SELECT tablename, file_id_ques
	             FROM file_analysis
	            WHERE id = @p1`
	var (
		tn  sql.NullString
		fiq sql.NullInt64
	)
	if err = db.QueryRow(q, analysisID).Scan(&tn, &fiq); err != nil {
		if err == sql.ErrNoRows {
			return "", 0, fmt.Errorf("找不到 file_analysis.id=%d", analysisID)
		}
		return "", 0, err
	}
	return tn.String, int(fiq.Int64), nil
}

// fetchTableColumns 對應 DB::table('analysis_data.INFORMATION_SCHEMA.COLUMNS')
func fetchTableColumns(db *sql.DB, tablename string) ([]string, error) {
	const q = `SELECT COLUMN_NAME
	             FROM analysis_data.INFORMATION_SCHEMA.COLUMNS
	            WHERE TABLE_NAME = @p1`
	rows, err := db.Query(q, tablename)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var cols []string
	for rows.Next() {
		var c string
		if err := rows.Scan(&c); err != nil {
			return nil, err
		}
		cols = append(cols, c)
	}
	return cols, rows.Err()
}

type censusPage struct {
	Page int
	XML  string
}

// fetchCensusPages 對應 Census::pages() (file_ques_page where file_id, 依 page 排序)
func fetchCensusPages(db *sql.DB, fileID int) ([]censusPage, error) {
	const q = `SELECT page, xml
	             FROM file_ques_page
	            WHERE file_id = @p1
	            ORDER BY page`
	rows, err := db.Query(q, fileID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var pages []censusPage
	for rows.Next() {
		var (
			p   sql.NullInt64
			xml sql.NullString
		)
		if err := rows.Scan(&p, &xml); err != nil {
			return nil, err
		}
		pages = append(pages, censusPage{Page: int(p.Int64), XML: xml.String})
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	sort.SliceStable(pages, func(i, j int) bool { return pages[i].Page < pages[j].Page })
	return pages, nil
}

// ---------------------------------------------------------------------------
// XML 解析 (對應 QuestionXML::xmlToArray / toArray / getSubs)
// ---------------------------------------------------------------------------

// xmlPage 對應一頁的 <page> 根節點，內含多個 <question> 與 <question_sub>。
type xmlPage struct {
	XMLName   xml.Name      `xml:"page"`
	Questions []xmlQuestion `xml:"question"`
	Subs      []xmlQuestion `xml:"question_sub"`
}

// xmlQuestion 對應 <question> / <question_sub> 節點。
type xmlQuestion struct {
	ID     string    `xml:"id"`
	Type   string    `xml:"type"`
	Title  string    `xml:"title"`
	IDLab  string    `xml:"idlab"`
	Answer xmlAnswer `xml:"answer"`
}

type xmlAnswer struct {
	Name     string      `xml:"name"`
	AutoHide string      `xml:"auto_hide,attr"`
	Code     string      `xml:"code,attr"`
	Degrees  []xmlDegree `xml:"degree"`
	Items    []xmlItem   `xml:"item"`
}

type xmlDegree struct {
	Value string `xml:"value,attr"`
	Text  string `xml:",chardata"`
}

type xmlItem struct {
	Value   string `xml:"value,attr"`
	Name    string `xml:"name,attr"`
	Skip    string `xml:"skip,attr"`
	Sub     string `xml:"sub,attr"`
	SubName string `xml:"sub_title,attr"`
	Size    string `xml:"size,attr"`
	Rows    string `xml:"rows,attr"`
	Cols    string `xml:"cols,attr"`
	Reset   string `xml:"reset,attr"`
	Text    string `xml:",chardata"`
}

// parsePageXML 解析一頁 XML，回傳攤平後的題目清單。
// 等同 PHP: 對每個 <question> 呼叫 toArray (建巢狀樹)，再用 getSubs 攤平。
func parsePageXML(raw string) ([]Question, error) {
	if strings.TrimSpace(raw) == "" {
		return nil, nil
	}
	var page xmlPage
	if err := xml.Unmarshal([]byte(raw), &page); err != nil {
		return nil, err
	}

	// 建立 question_sub 索引 (對應 xpath 由 sub id 找節點)
	subByID := make(map[string]xmlQuestion, len(page.Subs))
	for _, s := range page.Subs {
		subByID[s.ID] = s
	}

	var out []Question
	for _, q := range page.Questions {
		tree := toQuestionNode(q, subByID)
		flatten(tree, "", &out)
	}
	return out, nil
}

// questionNode 對應 QuestionXML::toArray 產生的巢狀題目樹。
type questionNode struct {
	Type    string
	Title   string
	Name    string
	Answers []answerNode
	SubQs   []questionNode // checkbox/scale/list/text 的子題 (對應 ->questions)
}

type answerNode struct {
	Title string
	Value string
	Subs  []questionNode
}

// toQuestionNode 對應 QuestionXML::toArray，遞迴建出題目樹。
func toQuestionNode(q xmlQuestion, subByID map[string]xmlQuestion) questionNode {
	node := questionNode{Type: q.Type, Title: strFilter(q.Title)}

	if q.Type == "radio" || q.Type == "select" {
		node.Name = q.Answer.Name
	}

	if q.Type == "scale" {
		for _, d := range q.Answer.Degrees {
			node.Answers = append(node.Answers, answerNode{
				Title: strFilter(d.Text),
				Value: d.Value,
			})
		}
	}

	for _, item := range q.Answer.Items {
		// 解析 sub 屬性 → 子題
		var subs []questionNode
		for _, subID := range splitNonEmpty(item.Sub) {
			if s, ok := subByID[subID]; ok {
				subs = append(subs, toQuestionNode(s, subByID))
			}
		}

		switch q.Type {
		case "radio", "select":
			node.Answers = append(node.Answers, answerNode{
				Title: strFilter(item.Text),
				Value: item.Value,
				Subs:  subs,
			})
		case "checkbox":
			node.SubQs = append(node.SubQs, questionNode{
				Type:  "checkbox",
				Title: strFilter(item.Text),
				Name:  item.Name,
				SubQs: subs,
			})
		case "scale":
			node.SubQs = append(node.SubQs, questionNode{
				Type:  "scale",
				Title: strFilter(item.Text),
				Name:  item.Name,
			})
		case "list":
			node.SubQs = append(node.SubQs, questionNode{
				Title: strFilter(item.Text),
				SubQs: subs,
			})
		case "text", "textarea":
			node.SubQs = append(node.SubQs, questionNode{
				Type:  q.Type,
				Title: strFilter(item.Text),
				Name:  item.Name,
			})
		}
	}

	return node
}

// flatten 對應 QuestionXML::getSubs，把巢狀樹攤平成一維題目清單。
func flatten(node questionNode, parentTitle string, out *[]Question) {
	switch node.Type {
	case "radio", "select":
		title := node.Title
		if parentTitle != "" {
			title = parentTitle + "-" + node.Title
		}
		var answers []Answer
		for _, a := range node.Answers {
			answers = append(answers, Answer{Value: a.Value, Title: a.Title})
		}
		*out = append(*out, Question{Name: node.Name, Title: title, Answers: answers})

		// 子題遞迴 (parent_title = sub.title-answer.title)
		for _, a := range node.Answers {
			for _, sub := range a.Subs {
				flatten(sub, title+"-"+a.Title, out)
			}
		}

	case "scale":
		// scale: 每個 sub question 為一題，共用 answers
		var answers []Answer
		for _, a := range node.Answers {
			answers = append(answers, Answer{Value: a.Value, Title: a.Title})
		}
		for _, sub := range node.SubQs {
			*out = append(*out, Question{
				Name:    sub.Name,
				Title:   node.Title + "-" + sub.Title,
				Answers: answers,
			})
		}

	case "checkbox":
		for _, sub := range node.SubQs {
			title := node.Title + "-" + sub.Title
			*out = append(*out, Question{
				Name:    sub.Name,
				Title:   title,
				Answers: []Answer{{Title: "是", Value: "1"}, {Title: "否", Value: "0"}},
			})
			for _, s := range sub.SubQs {
				flatten(s, title, out)
			}
		}

	case "list":
		title := node.Title
		if parentTitle != "" {
			title = parentTitle + "-" + node.Title
		}
		for _, sub := range node.SubQs {
			for _, s := range sub.SubQs {
				flatten(s, title, out)
			}
		}
	}
}

// ---------------------------------------------------------------------------
// 字串處理 (對應 QuestionXML::strFilter)
// ---------------------------------------------------------------------------

var (
	reTemplate = regexp.MustCompile(`{{[ ]?\${1}[\w]+[ ]?}}`)
	reTag      = regexp.MustCompile(`<[^>]*>`)
	reNbsp     = regexp.MustCompile(`&nbsp;`)
)

// strFilter 對應 QuestionXML::strFilter: 去除 {{ $var }}、HTML 標籤、換行、&nbsp;
func strFilter(s string) string {
	s = reTemplate.ReplaceAllString(s, "")
	s = strings.ReplaceAll(s, "\r\n", "")
	s = strings.ReplaceAll(s, "\n", "")
	s = strings.ReplaceAll(s, "\r", "")
	s = reTag.ReplaceAllString(s, "")
	s = reNbsp.ReplaceAllString(s, "")
	return s
}

// splitNonEmpty 對應 PHP array_filter(explode(',', $attr)): 以逗號切割並去除空字串。
func splitNonEmpty(s string) []string {
	var out []string
	for _, p := range strings.Split(s, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

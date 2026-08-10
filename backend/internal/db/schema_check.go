package db

import "gorm.io/gorm"

// SchemaCheck is one table's comparison of its GORM struct definition(s)
// against the database's actual columns/primary key. AutoMigrate can't
// handle a renamed column or a changed primary key (it only ever adds
// what's missing) — this exists to catch that class of drift, which
// AutoMigrate itself would never surface as an error. This codebase doesn't
// use AutoMigrate at all (schema.sql is the single source of truth, see
// Open's doc comment), but the same drift can still happen by hand: a
// column renamed in schema.sql without updating the Go struct that reads
// it, or vice versa.
type SchemaCheck struct {
	Table string `json:"table"`
	// MissingColumns: declared by a struct but absent from the database.
	MissingColumns []string `json:"missingColumns,omitempty"`
	// ExtraColumns: present in the database but not declared by any struct
	// mapped to this table.
	ExtraColumns []string `json:"extraColumns,omitempty"`
	// PrimaryKeyMismatch is nil unless at least one of the table's structs
	// declares a primaryKey column, and that declared set disagrees with
	// the database's actual primary key.
	PrimaryKeyMismatch *PrimaryKeyMismatch `json:"primaryKeyMismatch,omitempty"`
	// Ok is true when MissingColumns and ExtraColumns are both empty and
	// PrimaryKeyMismatch is nil.
	Ok bool `json:"ok"`
}

type PrimaryKeyMismatch struct {
	Expected []string `json:"expected"`
	Actual   []string `json:"actual"`
}

// CheckTable compares a table's GORM struct definitions against the live
// database. structs must all share the same TableName() (callers pass every
// struct across the codebase that maps to that table — several tables here
// are modeled by more than one narrow struct, one per owning package; see
// e.g. auth.appAuthRow's doc comment for why — so that no single package's
// narrow view misreports another package's columns as "extra").
func CheckTable(gormDB *gorm.DB, table string, structs ...any) (SchemaCheck, error) {
	// A fresh session per call: db.Migrator()/Statement.Parse must not run
	// against a *gorm.DB that might carry Where/Limit/etc. state from a
	// prior chained call on the same handle (adminconsole's schema-check
	// endpoint calls this once per table on the same *gorm.DB) — without
	// .Session(), that leftover clause state can leak into the queries
	// ColumnTypes issues here.
	gormDB = gormDB.Session(&gorm.Session{})
	migrator := gormDB.Migrator()
	expectedColumns := map[string]bool{}
	expectedPK := map[string]bool{}
	sawPKDeclaration := false

	for _, dst := range structs {
		stmt := &gorm.Statement{DB: gormDB}
		if err := stmt.Parse(dst); err != nil {
			return SchemaCheck{}, err
		}
		for _, f := range stmt.Schema.Fields {
			if f.DBName == "" {
				continue
			}
			expectedColumns[f.DBName] = true
			if f.PrimaryKey {
				sawPKDeclaration = true
				expectedPK[f.DBName] = true
			}
		}
	}

	columnTypes, err := migrator.ColumnTypes(structs[0])
	if err != nil {
		return SchemaCheck{}, err
	}
	actualColumns := map[string]bool{}
	actualPK := map[string]bool{}
	for _, ct := range columnTypes {
		actualColumns[ct.Name()] = true
		if isPK, ok := ct.PrimaryKey(); ok && isPK {
			actualPK[ct.Name()] = true
		}
	}

	check := SchemaCheck{Table: table}
	for col := range expectedColumns {
		if !actualColumns[col] {
			check.MissingColumns = append(check.MissingColumns, col)
		}
	}
	for col := range actualColumns {
		if !expectedColumns[col] {
			check.ExtraColumns = append(check.ExtraColumns, col)
		}
	}
	if sawPKDeclaration && !sameStringSet(expectedPK, actualPK) {
		check.PrimaryKeyMismatch = &PrimaryKeyMismatch{
			Expected: sortedKeys(expectedPK),
			Actual:   sortedKeys(actualPK),
		}
	}
	check.Ok = len(check.MissingColumns) == 0 && len(check.ExtraColumns) == 0 && check.PrimaryKeyMismatch == nil
	return check, nil
}

func sameStringSet(a, b map[string]bool) bool {
	if len(a) != len(b) {
		return false
	}
	for k := range a {
		if !b[k] {
			return false
		}
	}
	return true
}

func sortedKeys(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && out[j-1] > out[j]; j-- {
			out[j-1], out[j] = out[j], out[j-1]
		}
	}
	return out
}

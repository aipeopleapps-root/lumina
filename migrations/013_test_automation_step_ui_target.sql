-- Structured UI target for each test step. The execution worker used to infer the
-- element to click/fill by parsing a quoted name out of the free-text action; steps
-- without quotes were skipped. Storing the target separately makes execution independent
-- of how the generator phrased the action. Nullable: steps generated before this column
-- existed keep working via the quote-parsing fallback.

ALTER TABLE test_automation.steps ADD COLUMN IF NOT EXISTS ui_target TEXT;

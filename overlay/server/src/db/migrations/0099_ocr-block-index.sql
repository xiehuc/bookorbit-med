CREATE TABLE "ocr_blocks" (
	"file_id" integer NOT NULL,
	"page" integer NOT NULL,
	"block_id" integer NOT NULL,
	"text" text NOT NULL,
	"normalized_text" text NOT NULL,
	"search_grams" text[] NOT NULL,
	"bbox" jsonb,
	CONSTRAINT "ocr_blocks_file_id_page_block_id_pk" PRIMARY KEY("file_id","page","block_id")
);
--> statement-breakpoint
CREATE TABLE "ocr_documents" (
	"file_id" integer PRIMARY KEY NOT NULL,
	"fingerprint" varchar(64) NOT NULL,
	"page_count" integer NOT NULL,
	"indexed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ocr_pages" (
	"file_id" integer NOT NULL,
	"page" integer NOT NULL,
	"source" text NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	CONSTRAINT "ocr_pages_file_id_page_pk" PRIMARY KEY("file_id","page")
);
--> statement-breakpoint
ALTER TABLE "ocr_blocks" ADD CONSTRAINT "ocr_blocks_file_id_ocr_documents_file_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."ocr_documents"("file_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ocr_documents" ADD CONSTRAINT "ocr_documents_file_id_book_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."book_files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ocr_pages" ADD CONSTRAINT "ocr_pages_file_id_ocr_documents_file_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."ocr_documents"("file_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ocr_blocks_search_grams_idx" ON "ocr_blocks" USING gin ("search_grams");
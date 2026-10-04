CREATE TABLE "ocr_index_state" (
	"file_id" integer PRIMARY KEY NOT NULL,
	"source_stamp" varchar(64) NOT NULL,
	"status" varchar(16) NOT NULL,
	"indexed_fingerprint" varchar(64),
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ocr_index_state" ADD CONSTRAINT "ocr_index_state_file_id_book_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."book_files"("id") ON DELETE cascade ON UPDATE no action;
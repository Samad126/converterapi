import os

NO_TABLES_EXIT_CODE = 2

# Tesseract language codes, joined with '+' the way tesseract/ocrmypdf expect.
# English plus the languages this service's own real-world documents use
# (Azerbaijani, Turkish - the same alphabet family and the same "print to
# PDF" driver behaviour - and Russian, common alongside them in the same
# region). Overridable so a deployment with a different document mix is not
# stuck paying for language data it never uses.
OCR_LANGUAGES = os.environ.get('OCR_LANGUAGES', 'eng+aze+tur+rus')

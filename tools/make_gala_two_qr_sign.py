from pathlib import Path

from PIL import Image
from reportlab.graphics.barcode import qr
from reportlab.lib.colors import HexColor, black, white
from reportlab.lib.pagesizes import landscape, letter
from reportlab.pdfgen.canvas import Canvas


PROGRAM_URL = "https://drive.google.com/file/d/1nQ7lFA_itvXGMGSkbtxVjo50RTcq_0vS/view?usp=sharing"
DONATION_URL = "https://beingafrican.org/donate/"
OUTPUT = Path("output/pdf")
TEMP = Path("tmp/pdfs")
EXTRACTED_LOGO = TEMP / "extracted-images" / "program-000.png"
EXTRACTED_LOGO_MASK = TEMP / "extracted-images" / "program-001.png"


def make_qr_png(value: str, path: Path, module_pixels: int = 14) -> None:
    widget = qr.QrCodeWidget(value, barLevel="H")
    widget.qr.make()
    modules = widget.qr.modules
    quiet = 4
    side = (len(modules) + quiet * 2) * module_pixels
    image = Image.new("1", (side, side), 1)
    pixels = image.load()
    for row, values in enumerate(modules):
        for column, dark in enumerate(values):
            if dark:
                x0 = (column + quiet) * module_pixels
                y0 = (row + quiet) * module_pixels
                for y in range(y0, y0 + module_pixels):
                    for x in range(x0, x0 + module_pixels):
                        pixels[x, y] = 0
    image.save(path, dpi=(300, 300))


def make_logo_png(path: Path) -> None:
    color = Image.open(EXTRACTED_LOGO).convert("RGBA")
    alpha = Image.open(EXTRACTED_LOGO_MASK).convert("L")
    color.putalpha(alpha)
    color.save(path)


def draw_card(canvas: Canvas, x: float, title: str, subtitle: str, qr_path: Path, url_label: str) -> None:
    card_width = 340
    card_height = 430
    bottom = 55
    green = HexColor("#176B52")
    pale = HexColor("#F7F2E9")

    canvas.setFillColor(pale)
    canvas.setStrokeColor(HexColor("#D9CFBE"))
    canvas.roundRect(x, bottom, card_width, card_height, 18, fill=1, stroke=1)

    canvas.setFillColor(green)
    canvas.setFont("Helvetica-Bold", 25)
    canvas.drawCentredString(x + card_width / 2, bottom + card_height - 48, title)
    canvas.setFillColor(black)
    canvas.setFont("Helvetica", 13)
    canvas.drawCentredString(x + card_width / 2, bottom + card_height - 74, subtitle)

    qr_size = 260
    qr_x = x + (card_width - qr_size) / 2
    qr_y = bottom + 86
    canvas.drawImage(str(qr_path), qr_x, qr_y, qr_size, qr_size, preserveAspectRatio=True, mask="auto")

    canvas.setFont("Helvetica-Bold", 12)
    canvas.drawCentredString(x + card_width / 2, bottom + 54, "Open your camera and point it at the code")
    canvas.setFillColor(green)
    canvas.setFont("Helvetica", 11)
    canvas.drawCentredString(x + card_width / 2, bottom + 31, url_label)


def make_sign() -> Path:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    TEMP.mkdir(parents=True, exist_ok=True)
    program_qr = TEMP / "gala-program-qr.png"
    donation_qr = TEMP / "gala-donation-qr.png"
    logo = TEMP / "beingafrican-logo-extracted.png"
    make_qr_png(PROGRAM_URL, program_qr)
    make_qr_png(DONATION_URL, donation_qr)
    make_logo_png(logo)

    output_path = OUTPUT / "beingafrican-gala-program-and-donation-qr-sign.pdf"
    width, height = landscape(letter)
    canvas = Canvas(str(output_path), pagesize=(width, height))
    orange = HexColor("#D75A1E")
    green = HexColor("#176B52")

    canvas.setFillColor(orange)
    canvas.rect(0, height - 72, width, 72, fill=1, stroke=0)
    canvas.setFillColor(white)
    canvas.roundRect(24, height - 65, 178, 58, 8, fill=1, stroke=0)
    canvas.drawImage(str(logo), 32, height - 61, 162, 50, preserveAspectRatio=True, mask="auto")
    canvas.setFillColor(white)
    canvas.setFont("Helvetica-Bold", 27)
    canvas.drawCentredString(497, height - 45, "BEING AFRICAN GALA DINNER")

    draw_card(canvas, 42, "TONIGHT'S PROGRAM", "View the evening's full program", program_qr, "Program - Google Drive")
    draw_card(canvas, 410, "MAKE A DONATION", "Help preserve heritage and empower generations", donation_qr, "beingafrican.org/donate")

    canvas.setFillColor(green)
    canvas.rect(0, 0, width, 24, fill=1, stroke=0)
    canvas.save()
    return output_path


if __name__ == "__main__":
    print(make_sign().resolve())

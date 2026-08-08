from pathlib import Path

from PIL import Image
from reportlab.graphics import renderSVG
from reportlab.graphics.barcode import qr
from reportlab.graphics.shapes import Drawing
from reportlab.lib.colors import HexColor, black, white
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen.canvas import Canvas


URL = "https://beingafrican.org/donate/"
OUTPUT = Path("artifacts/beingafrican-donation")


def qr_drawing(size: int) -> Drawing:
    widget = qr.QrCodeWidget(URL, barLevel="H")
    x1, y1, x2, y2 = widget.getBounds()
    width, height = x2 - x1, y2 - y1
    scale = size / max(width, height)
    drawing = Drawing(size, size, transform=[scale, 0, 0, scale, 0, 0])
    drawing.add(widget)
    return drawing


def make_qr_assets() -> None:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    drawing = qr_drawing(1200)
    renderSVG.drawToFile(drawing, str(OUTPUT / "beingafrican-donation-qr.svg"))

    # Render the module matrix directly so edges stay perfectly crisp.
    widget = qr.QrCodeWidget(URL, barLevel="H")
    widget.qr.make()
    modules = widget.qr.modules
    quiet_zone = 4
    pixels_per_module = 32
    pixel_size = (len(modules) + 2 * quiet_zone) * pixels_per_module
    image = Image.new("RGB", (pixel_size, pixel_size), "white")
    for row, values in enumerate(modules):
        for column, dark in enumerate(values):
            if dark:
                left = (column + quiet_zone) * pixels_per_module
                top = (row + quiet_zone) * pixels_per_module
                for y in range(top, top + pixels_per_module):
                    for x in range(left, left + pixels_per_module):
                        image.putpixel((x, y), (0, 0, 0))
    image.save(OUTPUT / "beingafrican-donation-qr.png", dpi=(300, 300))


def make_letter_sign() -> None:
    output_path = OUTPUT / "beingafrican-donation-sign-letter.pdf"
    canvas = Canvas(str(output_path), pagesize=letter)
    width, height = letter
    orange = HexColor("#D75A1E")
    green = HexColor("#176B52")

    canvas.setFillColor(orange)
    canvas.rect(0, height - 118, width, 118, fill=1, stroke=0)
    canvas.setFillColor(white)
    canvas.setFont("Helvetica-Bold", 38)
    canvas.drawCentredString(width / 2, height - 70, "SUPPORT BEINGAFRICAN")

    canvas.setFillColor(green)
    canvas.setFont("Helvetica-Bold", 26)
    canvas.drawCentredString(width / 2, height - 158, "Scan to donate")

    qr_png = str(OUTPUT / "beingafrican-donation-qr.png")
    qr_size = 390
    canvas.drawImage(qr_png, (width - qr_size) / 2, 205, qr_size, qr_size, preserveAspectRatio=True)

    canvas.setFillColor(black)
    canvas.setFont("Helvetica-Bold", 17)
    canvas.drawCentredString(width / 2, 168, "Open your phone camera and point it at the code")
    canvas.setFont("Helvetica", 15)
    canvas.drawCentredString(width / 2, 138, "Or visit: beingafrican.org/donate")
    canvas.setFont("Helvetica-Oblique", 12)
    canvas.drawCentredString(width / 2, 88, "Thank you for helping BeingAfrican continue its work.")
    canvas.setFillColor(green)
    canvas.rect(0, 0, width, 28, fill=1, stroke=0)
    canvas.save()


if __name__ == "__main__":
    make_qr_assets()
    make_letter_sign()
    print(f"Created donation materials in {OUTPUT.resolve()}")

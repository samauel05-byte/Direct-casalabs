# Genera public/mora/Plantilla_liquidacion_impuestos.xlsx (liquidación de impuestos de años anteriores:
# recargos + intereses mes a mes, con el régimen vigente en cada mes tomado de la hoja «Parámetros»).
# Uso: python3.13 scripts/gen-plantilla-mora.py
from datetime import date
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter as L
from openpyxl.worksheet.datavalidation import DataValidation

N = 240            # meses máximos de mora que calcula la hoja «Calc» (20 años)
FILAS = 60         # impuestos que se pueden liquidar a la vez
P0, P1 = 8, 19     # filas de la tabla de regímenes en «Parámetros»
HDR = PatternFill('solid', fgColor='92400E'); INP = PatternFill('solid', fgColor='FEF3C7'); WARN = PatternFill('solid', fgColor='FECACA'); TOT = PatternFill('solid', fgColor='F1EBE0')
WH = Font(bold=True, color='FFFFFF'); B = Font(bold=True)
thin = Side(style='thin', color='D6CBB8'); BOX = Border(left=thin, right=thin, top=thin, bottom=thin)
MONEY = '#,##0.00'; DT = 'dd/mm/yyyy'

wb = Workbook()
# ── Instrucciones ───────────────────────────────────────────────────────────
ws0 = wb.active; ws0.title = 'Instrucciones'
txt = [
 ('Liquidación de impuestos de años anteriores: recargos e intereses', True),
 ('', False),
 ('1. En «Liquidación» escribe cada impuesto (celdas amarillas): concepto, año, monto del impuesto, fecha de vencimiento y fecha de pago (vacía = la fecha de cálculo de «Parámetros»).', False),
 ('2. La hoja calcula MES A MES, desde el vencimiento hasta el pago, tomando en cada mes el régimen vigente de la hoja «Parámetros» (año tras año).', False),
 ('3. Recargo por mora: % del primer mes + % por cada mes o fracción adicional, hasta el tope; se aplica sobre el impuesto. Interés indemnizatorio: tasa mensual del régimen, compuesto (sobre el saldo con intereses acumulados) o simple, según «Parámetros».', False),
 ('4. Total a pagar = impuesto + recargo + interés. Cada «mes o fracción» cuenta como mes completo.', False),
 ('', False),
 ('IMPORTANTE — LOS PARÁMETROS SON EDITABLES Y DEBEN VERIFICARSE', True),
 ('Las tasas y reglas cambian por ley. Los regímenes precargados en «Parámetros» salen de fuentes públicas (DGII y referencias secundarias, que no coinciden del todo) y están marcados como VERIFICAR. Antes de usar un resultado, confirma cada régimen (porcentajes, tope, fecha de vigencia y tasa de interés de cada período) con la ley vigente en cada año o con la DGII, y corrige la tabla si hace falta.', False),
 ('El interés indemnizatorio de la Ley 30-26 (tasa del Banco Central + 30 puntos básicos) es variable: debes escribir la tasa mensual que corresponda; mientras esté vacía la hoja avisa en rojo y no da el resultado por bueno.', False),
 ('Fuentes consultadas (secundarias, verificar): https://siemprealdia.co/republica-dominicana/impuestos/recargos-por-mora-e-interes-indemnizatorio-dgii/ · https://ayuda.dgii.gov.do/conversations/informacin-general/ca516-qu-porcentaje-de-recargos-por-mora-e-inters-indemnizatorio-se-les-aplica-a-los-impuestos-que-dejo-de-pagar-en-su-fecha-lmite/5f3c176d8cd858ce879d2f10 · Código Tributario Ley 11-92 (dgii.gov.do)', False),
 ('No incluye amnistías, descuentos por pronto pago, multas ni sanciones: solo recargos e intereses.', False),
 ('Hoja «Calc»: cálculo mes a mes (no la modifiques). Soporta hasta %d meses de mora por impuesto y %d impuestos.' % (N, FILAS), False),
]
for i, (t, b) in enumerate(txt, 1):
    c = ws0.cell(i, 1, t); c.alignment = Alignment(wrap_text=True, vertical='top'); c.font = Font(bold=b, size=13 if i == 1 else 11)
ws0.column_dimensions['A'].width = 120

# ── Parámetros ──────────────────────────────────────────────────────────────
wp = wb.create_sheet('Parámetros')
wp['A1'] = 'Parámetros de la liquidación'; wp['A1'].font = Font(bold=True, size=13)
wp['A3'] = 'Fecha de cálculo (si no escribes fecha de pago)'; wp['B3'] = '=TODAY()'; wp['B3'].number_format = DT; wp['B3'].fill = INP
wp['A4'] = 'Interés indemnizatorio'; wp['B4'] = 'Compuesto'; wp['B4'].fill = INP
dv = DataValidation(type='list', formula1='"Compuesto,Simple"', allow_blank=False); wp.add_data_validation(dv); dv.add('B4')
wp['A5'] = 'Compuesto = cada mes sobre el saldo con intereses acumulados; Simple = siempre sobre el impuesto.'; wp['A5'].font = Font(italic=True, color='6A5C4B')
wp['A6'] = 'Máximo de meses de recargo e interés a pagar (amnistía; vacío = sin límite)'; wp['B6'].fill = INP
wp['C6'] = 'Ej.: 12 si una amnistía permite pagar el impuesto más hasta un año de recargos e intereses. VERIFICAR la norma aplicable.'; wp['C6'].font = Font(italic=True, color='6A5C4B')
wp['A7'] = 'Regímenes (ordénalos por fecha ascendente; cada fila rige desde su fecha hasta la siguiente)'; wp['A7'].font = B
heads = ['Rige desde', 'Recargo 1.er mes (%)', 'Recargo por cada mes adicional (%)', 'Tope de recargo (%) (vacío = sin tope)', 'Interés mensual (%)', 'Fuente / nota (VERIFICAR)']
HR = P0  # fila de encabezados
rows = [
 (date(2001, 1, 1), 10, 4, None, 1.00, 'Recargo 10 % el primer mes + 4 % por cada mes adicional (Art. 252, mod. Ley 147-00). Interés indemnizatorio 1 % mensual según indicación de Contabilidad (fuentes de la DGII citan 1.10 %: VERIFICAR). Antes de ~2015 el interés pudo ser distinto (Art. 27: tasa de la Junta Monetaria + 30 %). Tope: confirmar.'),
 (date(2026, 7, 1), 3, 3, 100, None, 'VERIFICAR. Ley 30-26: recargo 3 % mensual con tope 100 % del tributo; interés = tasa del Banco Central + 0.30 pts (ESCRIBE la tasa mensual vigente). Vigencia: fuentes dicen 18-jun-2026 o 01-jul-2026.'),
]
for j, h in enumerate(heads, 1):
    c = wp.cell(HR, j, h); c.fill = HDR; c.font = WH; c.alignment = Alignment(wrap_text=True, vertical='center'); c.border = BOX
for k in range(P0 + 1, P1 + 1):
    r = rows[k - P0 - 1] if k - P0 - 1 < len(rows) else (None,) * 6
    for j in range(1, 7):
        c = wp.cell(k, j, r[j - 1]); c.fill = INP; c.border = BOX
        if j == 1: c.number_format = DT
        if j in (2, 3, 4, 5): c.number_format = '0.00'
        if j == 6: c.alignment = Alignment(wrap_text=True, vertical='top')
for col, w in zip('ABCDEF', [38, 16, 22, 22, 16, 90]): wp.column_dimensions[col].width = w
wp.row_dimensions[HR].height = 45
PA = f"Parámetros!$A${P0+1}:$A${P1}"; PB = f"Parámetros!$B${P0+1}:$B${P1}"; PC = f"Parámetros!$C${P0+1}:$C${P1}"; PD = f"Parámetros!$D${P0+1}:$D${P1}"; PE = f"Parámetros!$E${P0+1}:$E${P1}"

# ── Calc (mes a mes) ────────────────────────────────────────────────────────
wc = wb.create_sheet('Calc')
wc['A1'] = 'Cálculo mes a mes (no modificar). Bloque 1: tasa de cada mes · Bloque 2: factor de interés acumulado · Bloque 3: % de recargo acumulado'
RS, SS, PS = 8, 8 + N, 8 + 2 * N   # primera columna de cada bloque (H=8)
for k in range(1, N + 1):
    wc.cell(3, RS + k - 1, 'R%d' % k); wc.cell(3, SS + k - 1, 'S%d' % k); wc.cell(3, PS + k - 1, 'P%d' % k)
for j, h in enumerate(['Fila', 'Vence', 'Paga', 'Impuesto', 'Meses', 'Factor final', '% recargo'], 1): wc.cell(3, j, h).font = B
for r in range(FILAS):
    lr = 6 + r            # fila en «Liquidación»
    cr = 4 + r            # fila en «Calc»
    wc.cell(cr, 1, lr)
    wc.cell(cr, 2, f'=IF(Liquidación!D{lr}="","",Liquidación!D{lr})')
    wc.cell(cr, 3, f'=IF(Liquidación!D{lr}="","",IF(Liquidación!E{lr}="",Parámetros!$B$3,Liquidación!E{lr}))')
    wc.cell(cr, 4, f'=IF(Liquidación!C{lr}="",0,Liquidación!C{lr})')
    wc.cell(cr, 5, f'=IF(OR(B{cr}="",C{cr}<=B{cr}),0,MIN({N},IF(Parámetros!$B$6="",{N},Parámetros!$B$6),DATEDIF(B{cr},C{cr},"m")+IF(EDATE(B{cr},DATEDIF(B{cr},C{cr},"m"))<C{cr},1,0)))')
    for k in range(1, N + 1):
        rc, sc, pc = L(RS + k - 1), L(SS + k - 1), L(PS + k - 1)
        f_per = f'EDATE($B{cr},{k - 1})'
        m = f'MATCH({f_per},{PA},1)'
        wc[f'{rc}{cr}'] = f'=IF({k}>$E{cr},0,IFERROR(INDEX({PE},{m})/100,0))'
        prev_s = '1' if k == 1 else f'{L(SS + k - 2)}{cr}'
        wc[f'{sc}{cr}'] = f'=IF({k}>$E{cr},{prev_s},{prev_s}*(1+{rc}{cr}))'
        cap = f'IF(INDEX({PD},{m})="",1E9,INDEX({PD},{m}))'
        if k == 1:
            wc[f'{pc}{cr}'] = f'=IF({k}>$E{cr},0,MIN({cap},IFERROR(INDEX({PB},{m}),0)))'
        else:
            pp = f'{L(PS + k - 2)}{cr}'
            wc[f'{pc}{cr}'] = f'=IF({k}>$E{cr},{pp},MIN({cap},{pp}+IFERROR(INDEX({PC},{m}),0)))'
    wc.cell(cr, 6, f'={L(SS + N - 1)}{cr}'); wc.cell(cr, 7, f'={L(PS + N - 1)}{cr}')

# ── Liquidación ─────────────────────────────────────────────────────────────
wl = wb.create_sheet('Liquidación', 1)
wl['A1'] = 'Liquidación de impuestos de años anteriores (recargos + intereses)'; wl['A1'].font = Font(bold=True, size=13)
wl['A2'] = 'Escribe en las celdas amarillas. Verifica primero los regímenes de la hoja «Parámetros».'; wl['A2'].font = Font(italic=True, color='6A5C4B')
wl['A3'] = 'Contribuyente'; wl['A3'].font = B; wl['B3'].fill = INP; wl['C3'] = 'RNC'; wl['C3'].font = B; wl['D3'].fill = INP
wl['A4'] = 'Interés / fecha de cálculo'; wl['B4'] = '=Parámetros!B4'; wl['C4'] = '=Parámetros!B3'; wl['C4'].number_format = DT
H = ['Impuesto / concepto', 'Año', 'Impuesto adeudado (RD$)', 'Fecha de vencimiento', 'Fecha de pago (vacía = hoy)', 'Meses (o fracción)', 'Recargo (%)', 'Recargo (RD$)', 'Intereses (RD$)', 'Total a pagar (RD$)', 'Aviso']
for j, h in enumerate(H, 1):
    c = wl.cell(5, j, h); c.fill = HDR; c.font = WH; c.alignment = Alignment(wrap_text=True, vertical='center', horizontal='center'); c.border = BOX
wl.row_dimensions[5].height = 42
for r in range(FILAS):
    lr = 6 + r; cr = 4 + r
    for j in range(1, 6):
        c = wl.cell(lr, j); c.fill = INP; c.border = BOX
    wl.cell(lr, 3).number_format = MONEY; wl.cell(lr, 4).number_format = DT; wl.cell(lr, 5).number_format = DT
    wl.cell(lr, 6, f'=IF(D{lr}="","",IF(Calc!C{cr}<=Calc!B{cr},0,DATEDIF(Calc!B{cr},Calc!C{cr},"m")+IF(EDATE(Calc!B{cr},DATEDIF(Calc!B{cr},Calc!C{cr},"m"))<Calc!C{cr},1,0)))')
    wl.cell(lr, 7, f'=IF(D{lr}="","",Calc!G{cr})'); wl.cell(lr, 7).number_format = '0.00'
    wl.cell(lr, 8, f'=IF(D{lr}="","",ROUND(Calc!D{cr}*Calc!G{cr}/100,2))')
    sumr = f'SUM(Calc!{L(RS)}{cr}:{L(RS + N - 1)}{cr})'
    wl.cell(lr, 9, f'=IF(D{lr}="","",IF(Parámetros!$B$4="Simple",ROUND(Calc!D{cr}*{sumr},2),ROUND(Calc!D{cr}*(Calc!F{cr}-1),2)))')
    wl.cell(lr, 10, f'=IF(D{lr}="","",C{lr}+H{lr}+I{lr})')
    for j in (8, 9, 10): wl.cell(lr, j).number_format = MONEY
    pay = f'IF(E{lr}="",Parámetros!$B$3,E{lr})'
    wl.cell(lr, 11, f'=IF(D{lr}="","",IF(C{lr}="","Falta el monto del impuesto",IF({pay}<=D{lr},"La fecha de pago debe ser posterior al vencimiento",IF(COUNT({PA})=0,"Falta un régimen en Parámetros",IF(D{lr}<MIN({PA}),"El vencimiento es anterior al primer régimen de Parámetros",IF(SUMPRODUCT(({PA}<>"")*({PA}<={pay})*({PE}=""))>0,"Falta la tasa de interés de un régimen vigente en el período",IF(F{lr}>={N},"Supera el máximo de meses calculables","")))))))')
    wl.cell(lr, 11).font = Font(color='B91C1C', bold=True)
tr = 6 + FILAS
wl.cell(tr, 1, 'TOTALES').font = B
for j, col in ((3, 'C'), (8, 'H'), (9, 'I'), (10, 'J')):
    c = wl.cell(tr, j, f'=SUM({col}6:{col}{tr - 1})'); c.number_format = MONEY; c.font = B
for j in range(1, 12): wl.cell(tr, j).fill = TOT
for col, w in zip('ABCDEFGHIJK', [34, 8, 22, 18, 20, 12, 12, 16, 16, 20, 52]): wl.column_dimensions[col].width = w
wl.freeze_panes = 'A6'
# ejemplo de partida: una fila de muestra para ver el cálculo (se puede borrar)
wl['A6'] = 'Ejemplo: ITBIS 2022 (borra o reemplaza)'; wl['B6'] = 2022; wl['C6'] = 100000; wl['D6'] = date(2023, 3, 20); wl['E6'] = date(2026, 6, 20)
# ── Resumen por año ─────────────────────────────────────────────────────────
wr = wb.create_sheet('Resumen por año', 2)
wr['A1'] = 'Resumen por año fiscal'; wr['A1'].font = Font(bold=True, size=13)
wr['A2'] = 'Suma lo escrito en «Liquidación» por la columna «Año». Solo aparecen los años con impuestos.'; wr['A2'].font = Font(italic=True, color='6A5C4B')
for j, h in enumerate(['Año', 'Impuesto (RD$)', 'Recargo (RD$)', 'Intereses (RD$)', 'Total (RD$)'], 1):
    c = wr.cell(4, j, h); c.fill = HDR; c.font = WH; c.border = BOX; c.alignment = Alignment(horizontal='center')
last = 6 + FILAS - 1
for i, y in enumerate(range(2005, 2036)):
    r = 5 + i
    wr.cell(r, 1, y)
    for j, col in ((2, 'C'), (3, 'H'), (4, 'I'), (5, 'J')):
        wr.cell(r, j, f'=IF(COUNTIF(Liquidación!$B$6:$B${last},$A{r})=0,"",SUMIF(Liquidación!$B$6:$B${last},$A{r},Liquidación!${col}$6:${col}${last}))').number_format = MONEY
tr2 = 5 + 31
wr.cell(tr2, 1, 'TOTAL').font = B
for j, col in ((2, 'B'), (3, 'C'), (4, 'D'), (5, 'E')):
    c = wr.cell(tr2, j, f'=SUM({col}5:{col}{tr2 - 1})'); c.number_format = MONEY; c.font = B
for j in range(1, 6): wr.cell(tr2, j).fill = TOT
for col, w in zip('ABCDE', [10, 20, 20, 20, 20]): wr.column_dimensions[col].width = w
for w in (wl, wr, wp):
    w.page_setup.orientation = 'landscape'; w.page_setup.fitToWidth = 1; w.page_setup.fitToHeight = 0
    w.sheet_properties.pageSetUpPr.fitToPage = True
wc.sheet_properties.tabColor = '9CA3AF'
wb.save('public/mora/Plantilla_liquidacion_impuestos.xlsx')
print('ok')

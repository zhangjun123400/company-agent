"""图表生成器 — charted 全能力分发"""
import json, sys
from charted import BarChart, PieChart, RadarChart, GanttChart, LineChart, ColumnChart

def gen_bar(data_file, output):
    d = json.load(open(data_file, encoding='utf-8'))
    c = BarChart(d['values'], labels=d.get('labels'), width=700, height=350,
                 title=d.get('title',''), x_label=d.get('x_label',''), y_label=d.get('y_label',''))
    open(output, 'w', encoding='utf-8').write(c.to_svg())

def gen_pie(data_file, output):
    d = json.load(open(data_file, encoding='utf-8'))
    c = PieChart(d['values'], labels=d.get('labels'), width=600, height=400, title=d.get('title',''))
    open(output, 'w', encoding='utf-8').write(c.to_svg())

def gen_radar(data_file, output):
    d = json.load(open(data_file, encoding='utf-8'))
    c = RadarChart(d['series'][0]['values'], labels=d.get('labels'), width=500, height=400,
                   title=d.get('title',''), series_names=[s['name'] for s in d['series']])
    open(output, 'w', encoding='utf-8').write(c.to_svg())

def gen_gantt(data_file, output):
    """甘特图: {series: [[(s,e),...],...], labels: [...], title, series_names: [...]}"""
    d = json.load(open(data_file, encoding='utf-8'))
    series = [[tuple(p) for p in row] for row in d['series']]
    c = GanttChart(series, labels=d.get('labels'), width=800, height=max(120, 40*len(d.get('labels',[]))),
                   title=d.get('title',''), series_names=d.get('series_names'))
    open(output, 'w', encoding='utf-8').write(c.to_svg())

def gen_line(data_file, output):
    """折线图: {x_data, series: [{name, values}], title}"""
    d = json.load(open(data_file, encoding='utf-8'))
    c = LineChart(d['series'][0]['values'], labels=d.get('x_data'), width=700, height=350,
                  title=d.get('title',''), series_names=[s['name'] for s in d['series']])
    open(output, 'w', encoding='utf-8').write(c.to_svg())

def gen_column(data_file, output):
    """柱状图-垂直版: {labels, values, title}"""
    d = json.load(open(data_file, encoding='utf-8'))
    c = ColumnChart(d['values'], labels=d.get('labels'), width=700, height=350, title=d.get('title',''))
    open(output, 'w', encoding='utf-8').write(c.to_svg())

DISPATCH = {'bar': gen_bar, 'pie': gen_pie, 'radar': gen_radar, 'gantt': gen_gantt, 'line': gen_line, 'column': gen_column}

if __name__ == '__main__':
    cmd = sys.argv[1]; data_file = sys.argv[2]; output = sys.argv[3]
    DISPATCH[cmd](data_file, output)

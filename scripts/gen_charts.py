"""图表生成器 — 从 JSON 数据生成 SVG 图表，供版本管理报告使用"""
import json, sys, os
from charted import BarChart, PieChart, RadarChart, GanttChart

def gen_bar(data_file: str, output: str):
    """柱状图: {labels: [...], values: [...], title: str, x_label: str, y_label: str}"""
    d = json.load(open(data_file, encoding='utf-8'))
    c = BarChart(d['values'], labels=d.get('labels'), width=700, height=350,
                 title=d.get('title', ''), x_label=d.get('x_label',''), y_label=d.get('y_label',''))
    open(output, 'w', encoding='utf-8').write(c.to_svg())

def gen_pie(data_file: str, output: str):
    """饼图: {labels: [...], values: [...], title: str}"""
    d = json.load(open(data_file, encoding='utf-8'))
    c = PieChart(d['values'], labels=d.get('labels'), width=600, height=400,
                 title=d.get('title', ''))
    open(output, 'w', encoding='utf-8').write(c.to_svg())

def gen_radar(data_file: str, output: str):
    """雷达图: {labels: [...], series: [{name: str, values: [...]}], title: str}"""
    d = json.load(open(data_file, encoding='utf-8'))
    c = RadarChart(d['series'][0]['values'], labels=d.get('labels'), width=500, height=400,
                   title=d.get('title', ''), series_names=[s['name'] for s in d['series']])
    open(output, 'w', encoding='utf-8').write(c.to_svg())

if __name__ == '__main__':
    cmd = sys.argv[1]
    data_file = sys.argv[2]
    output = sys.argv[3]
    {'bar': gen_bar, 'pie': gen_pie, 'radar': gen_radar}[cmd](data_file, output)

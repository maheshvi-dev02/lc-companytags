"""Rebuild packaged brand logos from pinned Simple Icons and official site favicons.

No extension runtime downloads these assets. Dependencies: Python stdlib + Pillow.
Run after reviewing company identities/sources; never fuzzy-match brand names.
"""
import concurrent.futures
import gzip
import hashlib
import io
import json
import re
import tarfile
import unicodedata
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'extension' / 'logos'
CACHE = ROOT / 'output' / 'logo-source'
PINS = [
    ('current', '98820a4dc8c363ca72fa2c0d294ea4a0a9bba75d', 'data/simple-icons.json'),
    ('11.15.0', '0af835e2949a9222965522780e5e0810d3c53382', '_data/simple-icons.json'),
]
ALIASES = {
    'Airbus SE': 'Airbus', 'Electronic Arts': 'EA',
    'Palantir Technologies': 'Palantir', 'tcs': 'Tata Consultancy Services',
    'Walmart Labs': 'Walmart',
}
# These names can describe unrelated entities; do not choose by name alone.
AMBIGUOUS = {'Aurora', 'Bolt', 'Circle', 'Compass', 'Hive', 'Lucid', 'Slice', 'X'}
# Explicitly reviewed official company websites for brands absent from Simple Icons.
SITES = {
    'Accolite': 'https://www.accolite.com/',
    'Acko': 'https://www.acko.com/',
    'Affirm': 'https://www.affirm.com/',
    'Agoda': 'https://www.agoda.com/',
    'Airwallex': 'https://www.airwallex.com/',
    'Alibaba': 'https://www.alibabagroup.com/',
    'Altimetrik': 'https://www.altimetrik.com/',
    'Amadeus': 'https://amadeus.com/',
    'Amdocs': 'https://www.amdocs.com/',
    'Anduril': 'https://www.anduril.com/',
    'Aon': 'https://www.aon.com/',
    'Apollo.io': 'https://www.apollo.io/',
    'AppDynamics': 'https://www.appdynamics.com/',
    'AppFolio': 'https://www.appfolio.com/',
    'Arista Networks': 'https://www.arista.com/',
    'athenahealth': 'https://www.athenahealth.com/',
    'Avalara': 'https://www.avalara.com/',
    'Axon': 'https://www.axon.com/',
    'BlackRock': 'https://www.blackrock.com/',
    'BlackStone': 'https://www.blackstone.com/',
    'Blizzard': 'https://www.blizzard.com/',
    'Block': 'https://block.xyz/',
    'Bloomberg': 'https://www.bloomberg.com/',
    'BNY Mellon': 'https://www.bny.com/',
    'BP': 'https://www.bp.com/',
    'Braze': 'https://www.braze.com/',
    'Capgemini': 'https://www.capgemini.com/',
    'Capital One': 'https://www.capitalone.com/',
    'Chewy': 'https://www.chewy.com/',
    'Chime': 'https://www.chime.com/',
    'ciena': 'https://www.ciena.com/',
    'Citadel': 'https://www.citadel.com/',
    'Citigroup': 'https://www.citigroup.com/',
    'Comcast': 'https://corporate.comcast.com/',
    'Confluent': 'https://www.confluent.io/',
    'CRED': 'https://cred.club/',
    'Credit Karma': 'https://www.creditkarma.com/',
    'Criteo': 'https://www.criteo.com/',
    'CrowdStrike': 'https://www.crowdstrike.com/',
    'DE Shaw': 'https://www.deshaw.com/',
    'Delhivery': 'https://www.delhivery.com/',
    'Deloitte': 'https://www.deloitte.com/',
    'DevRev': 'https://devrev.ai/',
    'Devsinc': 'https://www.devsinc.com/',
    'Disney': 'https://thewaltdisneycompany.com/',
    'Dream11': 'https://www.dream11.com/',
    'Druva': 'https://www.druva.com/',
    'DXC Technology': 'https://dxc.com/',
    'EPAM Systems': 'https://www.epam.com/',
    'Epic Systems': 'https://www.epic.com/',
    'EY': 'https://www.ey.com/',
    'FactSet': 'https://www.factset.com/',
    'Fidelity': 'https://www.fidelity.com/',
    'Flexport': 'https://www.flexport.com/',
    'FreshWorks': 'https://www.freshworks.com/',
    'GE Digital': 'https://www.gevernova.com/software/',
    'GE Healthcare': 'https://www.gehealthcare.com/',
    'Geico': 'https://www.geico.com/',
    'Genpact': 'https://www.genpact.com/',
    'Groww': 'https://groww.in/',
    'HashedIn': 'https://www.hashedin.com/',
    'Honeywell': 'https://www.honeywell.com/',
    'HPE': 'https://www.hpe.com/',
    'Hulu': 'https://www.hulu.com/',
    'InMobi': 'https://www.inmobi.com/',
    'J.P. Morgan': 'https://www.jpmorgan.com/',
    'Jane Street': 'https://www.janestreet.com/',
    'Juspay': 'https://juspay.in/',
    'KLA': 'https://www.kla.com/',
    "Lowe's": 'https://www.lowes.com/',
    'LTI': 'https://www.ltimindtree.com/',
    'Luxoft': 'https://www.luxoft.com/',
    'MathWorks': 'https://www.mathworks.com/',
    'McKinsey': 'https://www.mckinsey.com/',
    'Meesho': 'https://www.meesho.com/',
    'Mercari': 'https://about.mercari.com/',
    'MindTree': 'https://www.ltimindtree.com/',
    'Mobileye': 'https://www.mobileye.com/',
    'Morgan Stanley': 'https://www.morganstanley.com/',
    'MSCI': 'https://www.msci.com/',
    'Myntra': 'https://www.myntra.com/',
    'Nagarro': 'https://www.nagarro.com/',
    'National Instruments': 'https://www.ni.com/',
    'NetEase': 'https://www.neteasegames.com/',
    'Netskope': 'https://www.netskope.com/',
    'Netsuite': 'https://www.netsuite.com/',
    'Nielsen': 'https://www.nielsen.com/',
    'Nykaa': 'https://www.nykaa.com/',
    'Optum': 'https://www.optum.com/',
    'Otter.ai': 'https://otter.ai/',
    'Ozon': 'https://www.ozon.ru/',
    'Paycom': 'https://www.paycom.com/',
    'PayPay': 'https://paypay.ne.jp/',
    'PayU': 'https://corporate.payu.com/',
    'persistent systems': 'https://www.persistent.com/',
    'Publicis Sapient': 'https://www.publicissapient.com/',
    'Pure Storage': 'https://www.purestorage.com/',
    'Pwc': 'https://www.pwc.com/',
    'RBC': 'https://www.rbc.com/',
    'Remitly': 'https://www.remitly.com/',
    'Rippling': 'https://www.rippling.com/',
    'Rivian': 'https://rivian.com/',
    'Roche': 'https://www.roche.com/',
    'Rubrik': 'https://www.rubrik.com/',
    'Samsara': 'https://www.samsara.com/',
    'ServiceNow': 'https://www.servicenow.com/',
    'Smartsheet': 'https://www.smartsheet.com/',
    'SoFi': 'https://www.sofi.com/',
    'Sprinklr': 'https://www.sprinklr.com/',
    'Synopsys': 'https://www.synopsys.com/',
    'Tech Mahindra': 'https://www.techmahindra.com/',
    'Tekion': 'https://tekion.com/',
    'Tencent': 'https://www.tencent.com/',
    'Texas Instruments': 'https://www.ti.com/',
    'The Trade Desk': 'https://www.thetradedesk.com/',
    'Thomson Reuters': 'https://www.thomsonreuters.com/',
    'thoughtspot': 'https://www.thoughtspot.com/',
    'ThoughtWorks': 'https://www.thoughtworks.com/',
    'Tiger Analytics': 'https://www.tigeranalytics.com/',
    'Tinkoff': 'https://www.tbank.ru/',
    'Toast': 'https://pos.toasttab.com/',
    'Turing': 'https://www.turing.com/',
    'Two Sigma': 'https://www.twosigma.com/',
    'UBS': 'https://www.ubs.com/',
    'UKG': 'https://www.ukg.com/',
    'USAA': 'https://www.usaa.com/',
    'Vanguard': 'https://corporate.vanguard.com/',
    'Veeva Systems': 'https://www.veeva.com/',
    'Verkada': 'https://www.verkada.com/',
    'Virtusa': 'https://www.virtusa.com/',
    'Warnermedia': 'https://www.wbd.com/',
    'Wayfair': 'https://www.wayfair.com/',
    'Waymo': 'https://waymo.com/',
    'Workday': 'https://www.workday.com/',
    'Yahoo': 'https://www.yahoo.com/',
    'Yandex': 'https://yandex.com/',
    'ZipRecruiter': 'https://www.ziprecruiter.com/',
    'ZScaler': 'https://www.zscaler.com/',
    'Zynga': 'https://www.zynga.com/',
}
# Rebranded names should retain the source-era identity until reviewed separately.
for _old in ['BNY Mellon', 'GE Digital', 'LTI', 'MindTree', 'Tinkoff', 'Warnermedia', 'AppDynamics', 'Hulu', 'Pure Storage']:
    SITES.pop(_old)


def get(url, limit=8 * 1024 * 1024, timeout=15):
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 CompanyLensLogoAssets/1.0'})
    with urllib.request.urlopen(req, timeout=timeout) as response:
        blob = response.read(limit + 1)
        if len(blob) > limit:
            raise ValueError('source exceeds size limit')
        return blob, response.geturl()


def normalize(name):
    return re.sub('[^a-z0-9]', '', unicodedata.normalize('NFKD', name).encode('ascii', 'ignore').decode().lower())


class IconParser(HTMLParser):
    def __init__(self):
        super().__init__(); self.icons = []; self.title = ''; self.in_title = False
    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'title': self.in_title = True
        if tag == 'link' and any(value == 'icon' or value.endswith('-icon') for value in attrs.get('rel', '').lower().split()):
            href = attrs.get('href', '')
            if href and not href.startswith('data:'): self.icons.append(href)
    def handle_endtag(self, tag):
        if tag == 'title': self.in_title = False
    def handle_data(self, data):
        if self.in_title: self.title += data


def raster_favicon(company, site):
    from PIL import Image
    parser = IconParser(); page_url = site
    try:
        page, page_url = get(site, limit=8 * 1024 * 1024)
        parser.feed(page.decode('utf-8', 'replace'))
    except Exception:
        # An official public favicon can be available when the site's landing page is not.
        pass
    candidates = [urllib.parse.urljoin(page_url, href) for href in parser.icons]
    candidates.append(urllib.parse.urljoin(page_url, '/favicon.ico'))
    candidates = sorted(set(candidates), key=lambda x: (not x.lower().endswith('.png'), not 'apple' in x.lower()))
    last = None
    for url in candidates[:8]:
        if urllib.parse.urlsplit(url).scheme != 'https': continue
        try:
            source, final_url = get(url, limit=2 * 1024 * 1024)
            if source.lstrip().startswith((b'<svg', b'<?xml')):
                output = safe_site_svg(source)
                filename = normalize(company) + '.svg'
                return company, filename, output, {
                    'provider': 'official-site-favicon', 'brandTitle': company,
                    'website': site, 'pageUrl': page_url, 'pageTitle': parser.title.strip(),
                    'assetSourceUrl': final_url, 'sourceSha256': hashlib.sha256(source).hexdigest(),
                    'retrievedAt': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
                    'license': 'Brand trademark; official site favicon, used to identify the company.',
                }
            im = Image.open(io.BytesIO(source))
            if im.format not in {'PNG', 'ICO', 'WEBP', 'JPEG'}: continue
            if im.width > 2048 or im.height > 2048: continue
            if im.format == 'ICO': im = im.ico.getimage(max(im.ico.sizes(), key=lambda size: size[0]*size[1]))
            im = im.convert('RGBA'); im.thumbnail((64, 64), Image.Resampling.LANCZOS)
            if company == 'Anduril':
                # Official mark is white; preserve the mark on a contrasting local tile.
                tile = Image.new('RGBA', (64, 64), '#17262e')
                tile.alpha_composite(im, ((64-im.width)//2, (64-im.height)//2)); im = tile
            buf = io.BytesIO(); im.save(buf, format='PNG', optimize=True)
            filename = normalize(company) + '.png'
            return company, filename, buf.getvalue(), {
                'provider': 'official-site-favicon', 'brandTitle': company,
                'website': site, 'pageUrl': page_url, 'pageTitle': parser.title.strip(),
                'assetSourceUrl': final_url, 'sourceSha256': hashlib.sha256(source).hexdigest(),
                'retrievedAt': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
                'license': 'Brand trademark; official site favicon, used to identify the company.',
                **({'renderingBackground': '#17262e'} if company == 'Anduril' else {}),
            }
        except Exception as error: last = str(error)
    raise RuntimeError(f'no raster favicon ({last or "no candidates"})')


def safe_site_svg(blob):
    if b'<!DOCTYPE' in blob.upper() or b'<!ENTITY' in blob.upper():
        raise ValueError('SVG entity declaration')
    tree = ET.fromstring(blob)
    tags = {'svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'polygon', 'polyline', 'line', 'title', 'desc'}
    attrs = {'viewBox', 'width', 'height', 'fill', 'stroke', 'fill-rule', 'clip-rule', 'd', 'points', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'transform', 'opacity', 'fill-opacity', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'stroke-opacity', 'version', 'id'}
    for node in tree.iter():
        tag = node.tag.rsplit('}', 1)[-1]
        if tag not in tags: raise ValueError('non-geometric favicon element ' + tag)
        for attr, value in list(node.attrib.items()):
            if attr in {'class', 'role', 'aria-hidden', 'focusable', 'aria-label'}:
                del node.attrib[attr]; continue
            if attr not in attrs or re.search(r'url|https?|javascript|data:|[<>]', value, re.I):
                raise ValueError('unsafe or unsupported favicon attribute ' + attr)
    ET.register_namespace('', 'http://www.w3.org/2000/svg')
    return ET.tostring(tree, encoding='utf-8') + b'\n'


def svg_geometry(blob, color):
    tree = ET.fromstring(blob)
    allowed_tags = {'svg', 'path', 'title'}
    paths = []
    for node in tree.iter():
        tag = node.tag.rsplit('}', 1)[-1]
        if tag not in allowed_tags: raise ValueError('unexpected SVG element ' + tag)
        for attr in node.attrib:
            if attr.lower().startswith('on') or attr.rsplit('}', 1)[-1] in {'href', 'src', 'style'}:
                raise ValueError('active SVG attribute')
        if tag == 'path':
            if set(node.attrib) != {'d'}: raise ValueError('unexpected path attribute')
            paths.append(node.attrib['d'])
    if tree.get('viewBox') != '0 0 24 24' or not paths: raise ValueError('unexpected icon geometry')
    if not re.fullmatch('[0-9A-Fa-f]{6}', color): raise ValueError('invalid color')
    return ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#' + color + '">' + ''.join('<path d="' + p + '"/>' for p in paths) + '</svg>\n').encode('utf-8')


def main():
    OUT.mkdir(parents=True, exist_ok=True); CACHE.mkdir(parents=True, exist_ok=True)
    data = json.loads(gzip.decompress((ROOT / 'extension/data/snapshot.json.gz').read_bytes()))
    company_names = [company['name'] for company in data['companies']]
    brands = {}; sources = []
    for label, revision, catalog_path in PINS:
        cache = CACHE / f'simple-icons-{label}.tar.gz'
        if cache.exists(): blob = cache.read_bytes()
        else:
            blob, _ = get('https://codeload.github.com/simple-icons/simple-icons/tar.gz/' + revision, limit=40 * 1024 * 1024, timeout=60)
            cache.write_bytes(blob)
        archive = tarfile.open(fileobj=io.BytesIO(blob), mode='r:gz')
        entries = {member.name.split('/', 1)[1]: member for member in archive.getmembers() if '/' in member.name}
        source_version = json.loads(archive.extractfile(entries['package.json']).read())['version']
        icons = json.loads(archive.extractfile(entries[catalog_path]).read())
        if isinstance(icons, dict): icons = icons['icons']
        for icon in icons:
            key = normalize(icon['title'])
            if key in brands: continue
            slug = icon.get('slug', normalize(icon['title']))
            path = 'icons/' + slug + '.svg'
            if path not in entries: continue
            brands[key] = (icon, slug, archive.extractfile(entries[path]).read(), revision, source_version)
        for filename in ['LICENSE.md', 'DISCLAIMER.md']:
            if filename in entries:
                (OUT / f'simple-icons-{label}-{filename.lower()}').write_bytes(archive.extractfile(entries[filename]).read())
        sources.append({'provider': 'Simple Icons', 'version': source_version, 'revision': revision, 'repository': 'https://github.com/simple-icons/simple-icons', 'license': 'CC0-1.0', 'archiveSha256': hashlib.sha256(blob).hexdigest()})
    mapping = {}; assets = {}
    for name in company_names:
        if name in AMBIGUOUS: continue
        record = brands.get(normalize(ALIASES.get(name, name)))
        if not record: continue
        icon, slug, blob, revision, label = record
        filename = slug + '.svg'
        if not re.fullmatch('[a-z0-9-]+[.]svg', filename): raise ValueError('unsafe slug')
        output = svg_geometry(blob, icon['hex'])
        (OUT / filename).write_bytes(output); mapping[name] = filename
        assets[filename] = {'provider': 'Simple Icons', 'version': label, 'revision': revision,
                            'brandTitle': icon['title'], 'brandSourceUrl': icon['source'],
                            'assetSourceUrl': f'https://raw.githubusercontent.com/simple-icons/simple-icons/{revision}/icons/{slug}.svg',
                            'license': icon.get('license', 'CC0-1.0'), 'sha256': hashlib.sha256(output).hexdigest()}
        if 'guidelines' in icon: assets[filename]['guidelines'] = icon['guidelines']
    # Keep vetted local official assets on repeat runs; remove an asset to fetch it again.
    prior = OUT / 'catalog.json'
    if prior.exists():
        existing = json.loads(prior.read_text(encoding='utf-8'))
        for record in existing.get('companies', {}).values():
            name = record['name']; filename = record['asset']; meta = existing['assets'].get(filename, {})
            if name in SITES and name not in mapping and meta.get('provider') == 'official-site-favicon' and (OUT / filename).exists():
                mapping[name] = filename; assets[filename] = meta
    failures = {}
    pending = [(name, site) for name, site in SITES.items() if name in company_names and name not in mapping and name not in AMBIGUOUS]
    with concurrent.futures.ThreadPoolExecutor(max_workers=10) as pool:
        jobs = {pool.submit(raster_favicon, name, site): name for name, site in pending}
        for future in concurrent.futures.as_completed(jobs):
            name = jobs[future]
            try:
                company, filename, blob, meta = future.result()
                (OUT / filename).write_bytes(blob); mapping[company] = filename
                meta['sha256'] = hashlib.sha256(blob).hexdigest(); assets[filename] = meta
                print('FAVICON', company, ascii(meta['pageTitle']), flush=True)
            except Exception as error:
                failures[name] = str(error); print('MISSING', name, str(error)[:100], flush=True)
    mapping = dict(sorted(mapping.items(), key=lambda item: item[0].casefold()))
    catalog = {'schemaVersion': 1, 'sources': sources,
               'companies': {unicodedata.normalize('NFKC', name).strip().lower(): {'name': name, 'asset': filename} for name, filename in mapping.items()},
               'assets': dict(sorted(assets.items())), 'unmappedCompanies': [name for name in company_names if name not in mapping],
               'ambiguousNames': sorted(AMBIGUOUS), 'aliases': ALIASES}
    (OUT / 'catalog.json').write_text(json.dumps(catalog, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
    js = '(function (root) {\n  const catalog = Object.freeze(' + json.dumps(mapping, indent=2, ensure_ascii=False) + ');\n  root.LCTLogoCatalog = catalog;\n  if (typeof module === "object" && module.exports) module.exports = catalog;\n})(typeof globalThis === "object" ? globalThis : this);\n'
    (ROOT / 'extension/logo-catalog.js').write_text(js, encoding='utf-8')
    for old_asset in OUT.iterdir():
        if old_asset.suffix in {'.svg', '.png'} and old_asset.name not in assets:
            if old_asset.resolve().parent != OUT.resolve(): raise ValueError('unsafe cleanup target')
            old_asset.unlink()
    (CACHE / 'favicon-failures.json').write_text(json.dumps(failures, indent=2), encoding='utf-8')
    totals = len(company_names); ts = [data['companies'][i]['name'] for i, _ in data['windows']['all']['index']['two-sum']]
    print('COVERAGE',len(mapping),'/',totals,'TWO SUM',sum(name in mapping for name in ts),'/',len(ts),flush=True)


if __name__ == '__main__': main()

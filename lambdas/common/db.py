"""
Database connection helper for Aurora Postgres using Data API
"""

import os
import json
import boto3
from contextlib import contextmanager

_rds_data = boto3.client('rds-data')
_DB_CLUSTER_ARN = os.environ.get('DB_CLUSTER_ARN', '')
_DB_SECRET_ARN = os.environ.get('DB_SECRET_ARN', '')
_DB_NAME = os.environ.get('DB_NAME', 'platform')


class Connection:
    """Simple connection wrapper for RDS Data API"""
    
    def __init__(self):
        self.transaction_id = None
    
    def cursor(self):
        return Cursor(self)
    
    def commit(self):
        if self.transaction_id:
            _rds_data.commit_transaction(
                resourceArn=_DB_CLUSTER_ARN,
                secretArn=_DB_SECRET_ARN,
                transactionId=self.transaction_id
            )
            self.transaction_id = None
    
    def rollback(self):
        if self.transaction_id:
            _rds_data.rollback_transaction(
                resourceArn=_DB_CLUSTER_ARN,
                secretArn=_DB_SECRET_ARN,
                transactionId=self.transaction_id
            )
            self.transaction_id = None


class Cursor:
    """Simple cursor wrapper for RDS Data API"""
    
    def __init__(self, conn):
        self.conn = conn
        self.last_result = None
    
    def execute(self, sql, params=None):
        """Execute SQL with optional parameters"""
        if not self.conn.transaction_id:
            # Start transaction
            response = _rds_data.begin_transaction(
                resourceArn=_DB_CLUSTER_ARN,
                secretArn=_DB_SECRET_ARN,
                database=_DB_NAME
            )
            self.conn.transaction_id = response['transactionId']
        
        # Convert params to RDS Data API format
        parameters = []
        if params:
            for i, value in enumerate(params):
                param = {'name': f'param{i}'}
                if value is None:
                    param['value'] = {'isNull': True}
                elif isinstance(value, bool):
                    param['value'] = {'booleanValue': value}
                elif isinstance(value, int):
                    param['value'] = {'longValue': value}
                elif isinstance(value, float):
                    param['value'] = {'doubleValue': value}
                else:
                    param['value'] = {'stringValue': str(value)}
                parameters.append(param)
            
            # Replace %s with :param0, :param1, etc
            for i in range(len(params)):
                sql = sql.replace('%s', f':param{i}', 1)
        
        # Execute
        self.last_result = _rds_data.execute_statement(
            resourceArn=_DB_CLUSTER_ARN,
            secretArn=_DB_SECRET_ARN,
            database=_DB_NAME,
            transactionId=self.conn.transaction_id,
            sql=sql,
            parameters=parameters if parameters else []
        )
    
    def fetchone(self):
        """Fetch one row"""
        if not self.last_result or 'records' not in self.last_result:
            return None
        records = self.last_result['records']
        if not records:
            return None
        return self._parse_record(records[0])
    
    def fetchall(self):
        """Fetch all rows"""
        if not self.last_result or 'records' not in self.last_result:
            return []
        return [self._parse_record(r) for r in self.last_result['records']]
    
    def _parse_record(self, record):
        """Parse a record from RDS Data API format to tuple"""
        result = []
        for field in record:
            if 'isNull' in field and field['isNull']:
                result.append(None)
            elif 'stringValue' in field:
                result.append(field['stringValue'])
            elif 'longValue' in field:
                result.append(field['longValue'])
            elif 'doubleValue' in field:
                result.append(field['doubleValue'])
            elif 'booleanValue' in field:
                result.append(field['booleanValue'])
            else:
                result.append(None)
        return tuple(result)


@contextmanager
def get_connection():
    """Get a database connection (context manager)"""
    conn = Connection()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
